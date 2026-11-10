"""Cloudflare queues with an HTTP pull consumer; CLOUDFLARE_API_TOKEN needs Queues Edit."""

import os
import time
from datetime import UTC, datetime, timedelta
from itertools import batched
from urllib.parse import SplitResult

from cloudflare import Cloudflare

from pandoks_queue.envelope import (
    Delivery,
    Message,
    batches,
    check_delay,
    decode_rows,
    delay_seconds,
    encode,
    parse_lease,
    query_params,
)

BATCH_COUNT = 100
BATCH_BYTES = 256_000
METADATA_BYTES = 100
EMPTY_POLL_DELAY = 1.0
# the ack warning for a retried message that moves to the dead-letter queue
DEAD_LETTERED = "Message has exhausted maxRetries"


def cloudflare_queues(parsed: SplitResult, *allowed: str) -> tuple[list[CloudflareQueue], dict[str, str]]:
    params = query_params(parsed, *allowed)
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        raise ValueError("cloudflare URL: CLOUDFLARE_API_TOKEN is not set")
    ids = parsed.path.removeprefix("/").split(",")
    if not parsed.netloc or "" in ids:
        raise ValueError(f"cloudflare URL {parsed.geturl()!r} must be cloudflare://<account_id>/<queue_id>[,<queue_id>…]")
    client = Cloudflare()
    return [CloudflareQueue(client, parsed.netloc, queue_id) for queue_id in ids], params


def open_queue(parsed: SplitResult) -> CloudflareQueue:
    queues, params = cloudflare_queues(parsed, "lease")
    if len(queues) != 1:
        raise ValueError("cloudflare URL: a queue has one queue id; a list is a topic")
    queues[0].lease = parse_lease(params)
    return queues[0]


def open_topic(parsed: SplitResult) -> CloudflareTopic:
    return CloudflareTopic(cloudflare_queues(parsed)[0])


def entries(messages: tuple[Message, ...]) -> list[dict]:
    sent_at = datetime.now(UTC)
    return [
        {"body": encode(message, sent_at), "content_type": "text", "delay_seconds": delay_seconds(message.delay)}
        for message in messages
    ]


class CloudflareQueue:
    def __init__(self, client: Cloudflare, account: str, queue_id: str):
        self.client, self.account, self.id, self.lease = client, account, queue_id, 0.0

    def push(self, pushed: list[dict]) -> None:
        for batch in batches(pushed, lambda entry: len(entry["body"].encode()) + METADATA_BYTES, BATCH_COUNT, BATCH_BYTES):
            self.client.queues.messages.bulk_push(self.id, account_id=self.account, messages=batch)

    def send(self, *messages: Message) -> None:
        self.push(entries(messages))

    def receive(self, max: int) -> list[Delivery]:
        if max < 1:
            raise ValueError(f"receive from Cloudflare: max {max} must be at least 1")
        deadline = datetime.now(UTC) + timedelta(seconds=self.lease)
        response = self.client.queues.messages.pull(
            self.id,
            account_id=self.account,
            batch_size=min(max, BATCH_COUNT),
            visibility_timeout_ms=round(self.lease * 1000),
        )
        pulled = (response.messages if response else None) or []
        deliveries, malformed = decode_rows(
            ((message.body, int(message.attempts) + 1, message.lease_id) for message in pulled), deadline
        )
        self._settle([{"lease_id": handle} for handle in malformed], [])
        # NOTE: pulls don't long-poll and every empty one is a billed read
        if not pulled:
            time.sleep(EMPTY_POLL_DELAY)
        return deliveries

    def _settle(self, acks: list[dict], retries: list[dict]) -> None:
        if not acks and not retries:
            return
        response = self.client.queues.messages.ack(self.id, account_id=self.account, acks=acks, retries=retries)
        warnings = list((response.warnings or {}).values()) if response else []
        dead_lettered = warnings.count(DEAD_LETTERED)
        if (
            response is None
            or response.ack_count != len(acks)
            or response.retry_count != len(retries)
            or dead_lettered != len(warnings)
            or dead_lettered > len(retries)
        ):
            raise RuntimeError(f"settle Cloudflare queue {self.id} messages: {response}")

    def ack(self, *deliveries: Delivery) -> None:
        for batch in batched(deliveries, BATCH_COUNT):
            self._settle([{"lease_id": delivery.handle} for delivery in batch], [])

    def retry(self, delay: float, *deliveries: Delivery) -> None:
        check_delay(delay)
        for batch in batched(deliveries, BATCH_COUNT):
            self._settle([], [{"lease_id": delivery.handle, "delay_seconds": delay_seconds(delay)} for delivery in batch])

    def close(self) -> None:
        self.client.close()


class CloudflareTopic:
    """Sends each message to every listed queue. It isn't atomic: a failed publish is retried
    whole, so subscribers dedupe on the envelope id."""

    def __init__(self, subscriptions: list[CloudflareQueue]):
        self.subscriptions = subscriptions

    def publish(self, *messages: Message) -> None:
        if any(message.delay for message in messages):
            raise ValueError("publish to Cloudflare: topics take no delay")
        published = entries(messages)
        for subscription in self.subscriptions:
            subscription.push(published)

    def close(self) -> None:
        self.subscriptions[0].client.close()
