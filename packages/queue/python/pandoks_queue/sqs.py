"""SQS queues; credentials come from boto3's default chain."""

import re
from itertools import batched
from datetime import UTC, datetime, timedelta
from urllib.parse import SplitResult, unquote

import boto3

from pandoks_queue.envelope import (
    Delivery,
    Message,
    batches,
    check_delay,
    decode_rows,
    delay_seconds,
    encode,
    log,
    parse_lease,
    query_params,
)

BATCH_COUNT = 10
BATCH_BYTES = 1 << 20
WAIT_SECONDS = 20
HOST = re.compile(r"sqs\.([a-z0-9-]+)\.amazonaws\.com")
PATH = re.compile(r"/[^/]+/[^/]+")


def check_failed(action: str, response: dict) -> None:
    if failed := response.get("Failed"):
        raise RuntimeError(f"{action}: {len(failed)} failed: {failed[0].get('Message')}")


def open_queue(parsed: SplitResult) -> SQSQueue:
    region = HOST.fullmatch(parsed.netloc)
    if region is None or PATH.fullmatch(unquote(parsed.path)) is None:
        raise ValueError("awssqs URL must be awssqs://sqs.<region>.amazonaws.com/<account>/<name>")
    if unquote(parsed.path).endswith(".fifo"):
        raise ValueError("awssqs URL: FIFO queues are not supported, since Send sets no MessageGroupId")
    params = query_params(parsed, "lease", "endpoint")
    lease = parse_lease(parsed, params)
    if lease % 1:
        raise ValueError(f"awssqs URL: lease {params['lease']!r} must be whole seconds")
    client = boto3.client("sqs", region_name=region[1], endpoint_url=params.get("endpoint"))
    return SQSQueue(client, f"https://{parsed.netloc}{parsed.path}", lease)


class SQSQueue:
    def __init__(self, client, url: str, lease: float):
        self.client, self.url, self.lease = client, url, lease

    def send(self, *messages: Message) -> None:
        sent_at = datetime.now(UTC)
        # NOTE: like Go's SDK, leave DelaySeconds out for no delay, so SQS applies the queue's default
        entries = [
            {"Id": str(index), "MessageBody": encode(message, sent_at)}
            | ({"DelaySeconds": delay_seconds(message.delay)} if message.delay else {})
            for index, message in enumerate(messages)
        ]
        for batch in batches(entries, lambda entry: len(entry["MessageBody"].encode()), BATCH_COUNT, BATCH_BYTES):
            check_failed("send to SQS", self.client.send_message_batch(QueueUrl=self.url, Entries=batch))

    def receive(self, max: int) -> list[Delivery]:
        if not isinstance(max, int) or max < 1:
            raise ValueError(f"receive from SQS: max {max} must be a positive integer")
        response = self.client.receive_message(
            QueueUrl=self.url,
            MaxNumberOfMessages=min(max, BATCH_COUNT),
            WaitTimeSeconds=WAIT_SECONDS,
            VisibilityTimeout=int(self.lease),
            MessageSystemAttributeNames=["ApproximateReceiveCount"],
        )
        # NOTE: the visibility timeout starts when the long poll returns a message
        deadline = datetime.now(UTC) + timedelta(seconds=self.lease)
        rows = [
            (message["Body"], int(message["Attributes"]["ApproximateReceiveCount"]), message["ReceiptHandle"])
            for message in response.get("Messages", [])
        ]
        deliveries, malformed = decode_rows(rows, deadline)
        # NOTE: a malformed message whose ack fails returns and is dropped again
        try:
            self._delete(malformed)
        except Exception:
            log.exception("queue failed to ack malformed messages")
        return deliveries

    def _delete(self, handles: list) -> None:
        for batch in batched(handles, BATCH_COUNT):
            entries = [{"Id": str(index), "ReceiptHandle": handle} for index, handle in enumerate(batch)]
            check_failed("ack SQS messages", self.client.delete_message_batch(QueueUrl=self.url, Entries=entries))

    def ack(self, *deliveries: Delivery) -> None:
        self._delete([delivery.handle for delivery in deliveries])

    def retry(self, delay: float, *deliveries: Delivery) -> None:
        check_delay(delay)
        for batch in batched(deliveries, BATCH_COUNT):
            entries = [
                {"Id": str(index), "ReceiptHandle": delivery.handle, "VisibilityTimeout": delay_seconds(delay)}
                for index, delivery in enumerate(batch)
            ]
            check_failed(
                "retry SQS messages", self.client.change_message_visibility_batch(QueueUrl=self.url, Entries=entries)
            )

    def close(self) -> None:
        self.client.close()
