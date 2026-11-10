"""Queue and pub/sub over SQS and SNS, Cloudflare Queues, or Valkey, chosen by URL.

See packages/queue/README.md for the spec the Go, Python, and TypeScript packages share.
Install the extras for the brokers you use: pandoks-queue[sqs,cloudflare,valkey].
"""

from importlib import import_module
from urllib.parse import urlsplit

from pandoks_queue.envelope import MAX_DELAY, MAX_ENVELOPE_BYTES, Delivery, Message, Queue, Topic
from pandoks_queue.worker import Permanent, RetryAfter, Worker

__all__ = [
    "MAX_DELAY",
    "MAX_ENVELOPE_BYTES",
    "Delivery",
    "Message",
    "Permanent",
    "Queue",
    "RetryAfter",
    "Topic",
    "Worker",
    "open_queue",
    "open_topic",
]

QUEUE_ADAPTERS = {"awssqs": "sqs", "cloudflare": "cloudflare", "valkey": "valkey"}
TOPIC_ADAPTERS = {"awssns": "sns", "cloudflare": "cloudflare", "valkey": "valkey"}


def open_queue(url: str) -> Queue:
    """Opens a queue, or a topic's subscription, from its URL."""
    parsed = urlsplit(url)
    if parsed.scheme not in QUEUE_ADAPTERS:
        raise ValueError(f"open queue: unknown scheme {parsed.scheme!r}")
    return import_module(f"pandoks_queue.{QUEUE_ADAPTERS[parsed.scheme]}").open_queue(parsed)


def open_topic(url: str) -> Topic:
    """Opens a topic from its URL."""
    parsed = urlsplit(url)
    if parsed.scheme not in TOPIC_ADAPTERS:
        raise ValueError(f"open topic: unknown scheme {parsed.scheme!r}")
    return import_module(f"pandoks_queue.{TOPIC_ADAPTERS[parsed.scheme]}").open_topic(parsed)
