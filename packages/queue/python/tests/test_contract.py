"""The contract every adapter meets, against compose.yaml's brokers and, in CI, Cloudflare."""

import json
import os
import secrets
import time
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

import boto3
from valkey.cluster import ValkeyCluster
from valkey.exceptions import ResponseError

from pandoks_queue import Message, open_queue, open_topic
from pandoks_queue.envelope import decode, encode

VALKEY_PORT = 16379
MOTO_ENDPOINT = "http://127.0.0.1:15000"
MOTO_ACCOUNT = "123456789012"
REGION = "us-west-1"
WAIT = 30.0
FIXTURES = sorted((Path(__file__).resolve().parents[2] / "testdata" / "envelopes").glob("*.json"))


def test_message(name):
    return Message(
        id=f"{name}-{secrets.token_hex(8)}", source="//pandoks.com/queue/test", type="com.pandoks.queue.test",
        data=json.dumps({"case": name}).encode(),
    )


def receive(queue, timeout, *ids):
    """Collects deliveries of the wanted ids until all arrive or timeout passes, acking any other
    message (a leftover from an earlier run)."""
    got = {}
    end = time.monotonic() + timeout
    while len(got) < len(ids) and time.monotonic() < end:
        for delivery in queue.receive(10):
            if delivery.id in ids:
                got[delivery.id] = delivery
            else:
                queue.ack(delivery)
    return got


def received_ids(queue):
    deliveries = queue.receive(10)
    queue.ack(*deliveries)
    return [delivery.id for delivery in deliveries]


class Contract:
    """Mixed into a TestCase whose setUp sets lease, max_attempts, queue, dead_letters, topic,
    and subscriptions."""

    def test_sends_receives_and_acks_golden_envelopes(self):
        sent = {}
        for path in FIXTURES:
            fixture = decode(path.read_text(), attempt=1, deadline=datetime.now(UTC))
            message = Message(
                id=f"{fixture.id}-{secrets.token_hex(8)}", source=fixture.source, type=fixture.type,
                data=fixture.data, content_type=fixture.content_type, extensions=fixture.extensions,
            )
            sent[message.id] = message
        self.queue.send(*sent.values())
        got = receive(self.queue, WAIT, *sent)
        self.assertEqual(set(got), set(sent))
        for id, message in sent.items():
            delivery = got[id]
            self.assertEqual(delivery.attempt, 1)
            self.assertLess(datetime.now(UTC) - delivery.time, timedelta(minutes=1))
            self.assertLessEqual(delivery.deadline - datetime.now(UTC), timedelta(seconds=self.lease))
            self.assertEqual(json.loads(encode(delivery, delivery.time)), json.loads(encode(message, delivery.time)))
            self.queue.ack(delivery)
        self.assertEqual(receive(self.queue, 2 * self.lease + 1, *sent), {})

    def test_retry_comes_back_after_its_delay_as_the_next_attempt(self):
        message = test_message("retry")
        self.queue.send(message)
        first = receive(self.queue, WAIT, message.id)[message.id]
        retried_at = time.monotonic()
        self.queue.retry(2, first)
        second = receive(self.queue, WAIT, message.id)[message.id]
        self.assertGreaterEqual(time.monotonic() - retried_at, 2)
        # NOTE: relative, since an SQS long poll from an earlier check can still take it once
        self.assertEqual(second.attempt, first.attempt + 1)
        self.queue.ack(second)

    def test_an_expired_lease_redelivers_as_the_next_attempt(self):
        message = replace(test_message("lease"), delay=1)
        sent_at = time.monotonic()
        self.queue.send(message)
        first = receive(self.queue, WAIT, message.id)[message.id]
        self.assertGreaterEqual(time.monotonic() - sent_at, 1)
        second = receive(self.queue, WAIT, message.id)[message.id]
        self.assertEqual(second.attempt, first.attempt + 1)
        self.assertGreaterEqual(time.monotonic() - sent_at, 1 + self.lease)
        self.queue.ack(second)

    def test_dead_letters_after_the_last_attempt(self):
        message = test_message("dead")
        self.queue.send(message)
        for attempt in range(1, self.max_attempts + 1):
            delivery = receive(self.queue, WAIT, message.id)[message.id]
            self.assertEqual(delivery.attempt, attempt)
            self.queue.retry(0, delivery)
        self.assertEqual(receive(self.queue, 2 * self.lease + 1, message.id), {})
        self.assertIn(message.id, self.dead_letters())

    def test_a_topic_reaches_every_subscription(self):
        message = test_message("topic")
        with self.assertRaises(ValueError):
            self.topic.publish(replace(message, delay=1))
        self.topic.publish(message)
        for subscription in self.subscriptions:
            delivery = receive(subscription, WAIT, message.id)[message.id]
            subscription.ack(delivery)

    def open(self, url, opener=open_queue):
        opened = opener(url)
        self.addCleanup(opened.close)
        return opened


class ValkeyContractTest(Contract, unittest.TestCase):
    def setUp(self):
        suffix = secrets.token_hex(5)
        base = f"valkey://client:client@127.0.0.1:{VALKEY_PORT}/"
        self.lease, self.max_attempts = 0.5, 3
        self.queue = self.open(f"{base}q{suffix}?lease=500ms&max_attempts=3")
        self.topic = self.open(f"{base}t{suffix}", open_topic)
        self.subscriptions = [
            self.open(f"{base}t{suffix}?subscription={name}&lease=500ms&max_attempts=3") for name in ("a", "b")
        ]
        client = self.client = ValkeyCluster(host="127.0.0.1", port=VALKEY_PORT, username="client", password="client", decode_responses=True)
        self.addCleanup(client.close)
        self.dead_letters = lambda: [
            decode(fields["envelope"], attempt=0, deadline=datetime.now(UTC)).id
            for _, fields in client.xrange("{q" + suffix + "}:dlq")
        ]

    def test_close_removes_only_settled_consumers(self):
        name = f"x{secrets.token_hex(5)}"
        url = f"valkey://client:client@127.0.0.1:{VALKEY_PORT}/{name}?lease=500ms&max_attempts=5"
        settled, holding = open_queue(url), open_queue(url)
        message = test_message("close")
        holding.send(message)
        self.assertIn(message.id, receive(holding, WAIT, message.id))
        settled.receive(1)
        settled.close()
        holding.close()
        consumers = self.client.xinfo_consumers("{" + name + "}:stream", "workers")
        self.assertEqual([consumer["name"] for consumer in consumers], [holding.consumer])

    def test_open_closes_the_client_when_subscribing_fails(self):
        name = f"s{secrets.token_hex(5)}"
        self.client.set("{" + name + "}:subscriptions", "not a set")
        with mock.patch.object(ValkeyCluster, "close", autospec=True, side_effect=ValkeyCluster.close) as close:
            with self.assertRaises(ResponseError):
                open_queue(f"valkey://client:client@127.0.0.1:{VALKEY_PORT}/{name}?subscription=a&lease=500ms&max_attempts=3")
        close.assert_called_once()


class SQSContractTest(Contract, unittest.TestCase):
    def setUp(self):
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
            os.environ.setdefault(name, "test")
        sqs = boto3.client("sqs", region_name=REGION, endpoint_url=MOTO_ENDPOINT)
        sns = boto3.client("sns", region_name=REGION, endpoint_url=MOTO_ENDPOINT)
        suffix = secrets.token_hex(5)

        def create_queue(name, attributes=None):
            url = sqs.create_queue(QueueName=name, Attributes=attributes or {})["QueueUrl"]
            return sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]

        def queue_url(name):
            return f"awssqs://sqs.{REGION}.amazonaws.com/{MOTO_ACCOUNT}/{name}?lease=1s&endpoint={MOTO_ENDPOINT}"

        dlq_arn = create_queue(f"dlq-{suffix}")
        redrive = json.dumps({"deadLetterTargetArn": dlq_arn, "maxReceiveCount": "3"})
        create_queue(f"q-{suffix}", {"RedrivePolicy": redrive})
        topic_arn = sns.create_topic(Name=f"t-{suffix}")["TopicArn"]
        self.subscriptions = []
        for name in ("a", "b"):
            arn = create_queue(f"t-{suffix}-{name}")
            sns.subscribe(TopicArn=topic_arn, Protocol="sqs", Endpoint=arn, Attributes={"RawMessageDelivery": "true"})
            self.subscriptions.append(self.open(queue_url(f"t-{suffix}-{name}")))
        self.lease, self.max_attempts = 1, 3
        self.queue = self.open(queue_url(f"q-{suffix}"))
        dlq = self.open(queue_url(f"dlq-{suffix}"))
        self.dead_letters = lambda: received_ids(dlq)
        self.topic = self.open(f"awssns:///{topic_arn}?endpoint={MOTO_ENDPOINT}", open_topic)


@unittest.skipUnless(os.environ.get("QUEUE_TEST_CLOUDFLARE_QUEUE"), "the tests.yaml Cloudflare job sets QUEUE_TEST_CLOUDFLARE_*")
class CloudflareContractTest(Contract, unittest.TestCase):
    """Runs against queues the CI job creates, each with an HTTP pull consumer; the main queue
    dead-letters to the second after max_retries 2."""

    def setUp(self):
        base = f"cloudflare://{os.environ['CLOUDFLARE_ACCOUNT_ID']}/"
        queue, dlq, subscription = (
            os.environ[f"QUEUE_TEST_CLOUDFLARE_{name}"] for name in ("QUEUE", "DLQ", "SUBSCRIPTION")
        )
        self.lease, self.max_attempts = 5, 3
        self.queue = self.open(f"{base}{queue}?lease=5s")
        dead_letter_queue = self.open(f"{base}{dlq}?lease=5s")
        self.dead_letters = lambda: received_ids(dead_letter_queue)
        self.topic = self.open(f"{base}{queue},{subscription}", open_topic)
        self.subscriptions = [self.open(f"{base}{queue}?lease=5s"), self.open(f"{base}{subscription}?lease=5s")]
