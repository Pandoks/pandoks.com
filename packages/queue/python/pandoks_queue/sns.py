"""SNS topics whose subscriptions are SQS queues with raw delivery on."""

from datetime import UTC, datetime
from urllib.parse import SplitResult

import boto3

from pandoks_queue.envelope import Message, batches, encode, query_params
from pandoks_queue.sqs import BATCH_COUNT, check_failed

BATCH_BYTES = 256 << 10


def open_topic(parsed: SplitResult) -> SNSTopic:
    arn = parsed.path.removeprefix("/")
    fields = arn.split(":")
    if parsed.netloc or len(fields) != 6 or fields[0] != "arn" or fields[2] != "sns":
        raise ValueError("awssns URL must be awssns:///arn:aws:sns:<region>:<account>:<name>")
    params = query_params(parsed, "endpoint")
    return SNSTopic(boto3.client("sns", region_name=fields[3], endpoint_url=params.get("endpoint")), arn)


class SNSTopic:
    def __init__(self, client, arn: str):
        self.client, self.arn = client, arn

    def publish(self, *messages: Message) -> None:
        if any(message.delay for message in messages):
            raise ValueError("publish to SNS: topics take no delay")
        sent_at = datetime.now(UTC)
        entries = [{"Id": str(index), "Message": encode(message, sent_at)} for index, message in enumerate(messages)]
        for batch in batches(entries, lambda entry: len(entry["Message"].encode()), BATCH_COUNT, BATCH_BYTES):
            check_failed("publish to SNS", self.client.publish_batch(TopicArn=self.arn, PublishBatchRequestEntries=batch))

    def close(self) -> None:
        self.client.close()
