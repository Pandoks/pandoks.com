"""The message types, the CloudEvents envelope, and the URL rules every adapter shares."""

import base64
import json
import logging
import math
import re
import secrets
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol
from urllib.parse import SplitResult, parse_qs

MAX_DELAY = 900.0
"""SQS's DelaySeconds maximum in seconds, the portable ceiling for every delay."""
MAX_ENVELOPE_BYTES = 120_000
"""Fits Cloudflare's 128 KB message limit with room for its metadata."""

EXTENSION_NAME = re.compile(r"[a-z0-9]{1,20}")
ATTRIBUTES = {"specversion", "id", "source", "type", "time", "datacontenttype", "data", "data_base64"}
DURATION = re.compile(r"(\d+)(ms|s|m|h)")
DURATION_SECONDS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}
LONE_SURROGATE = re.compile("[\ud800-\udfff]")
RFC3339 = re.compile(r"\d{4}-\d\d-\d\dT([01]\d|2[0-3]):\d\d:\d\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)", re.ASCII)

log = logging.getLogger("pandoks_queue")


@dataclass(kw_only=True)
class Message:
    """What a producer sends. JSON data goes in the envelope's data member, anything else in
    data_base64. An empty id becomes a random one."""

    source: str
    type: str
    data: bytes | None = None
    id: str = ""
    content_type: str = "application/json"
    extensions: dict[str, str] = field(default_factory=dict)
    delay: float = 0


@dataclass(kw_only=True)
class Delivery(Message):
    """A received message. attempt is 1 on the first delivery, and the broker redelivers it once
    deadline passes unless it is acked or retried first."""

    time: datetime
    attempt: int
    deadline: datetime
    handle: object = field(default=None, repr=False)


class Queue(Protocol):
    def send(self, *messages: Message) -> None: ...
    def receive(self, max: int) -> list[Delivery]: ...
    def ack(self, *deliveries: Delivery) -> None: ...
    def retry(self, delay: float, *deliveries: Delivery) -> None: ...
    def close(self) -> None: ...


class Topic(Protocol):
    def publish(self, *messages: Message) -> None: ...
    def close(self) -> None: ...


def is_json(content_type: str) -> bool:
    media_type = content_type.split(";")[0].strip().lower()
    return media_type == "application/json" or media_type.endswith("+json")


def encode(message: Message, sent_at: datetime) -> str:
    """Writes message as a CloudEvents 1.0 structured JSON envelope sent at sent_at."""
    attributes = (message.id or "", message.source, message.type, *message.extensions.values())
    if not all(isinstance(value, str) for value in attributes):
        raise ValueError("encode message: id, source, type, and extension values must be strings")
    if not message.source or not message.type:
        raise ValueError("encode message: source and type are required")
    check_delay(message.delay)
    for name in message.extensions:
        if not EXTENSION_NAME.fullmatch(name) or name in ATTRIBUTES:
            raise ValueError(f"encode message: extension name {name!r} must be [a-z0-9]{{1,20}} and not an attribute")
    event = {
        **message.extensions,
        "specversion": "1.0",
        "id": message.id or secrets.token_hex(16),
        "source": message.source,
        "type": message.type,
        "time": sent_at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "datacontenttype": message.content_type or "application/json",
    }
    if message.data is not None and is_json(event["datacontenttype"]):
        event["data"] = parse_json(message.data)
    elif message.data is not None:
        event["data_base64"] = base64.b64encode(message.data).decode()
    body = json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    # NOTE: a lone surrogate (like JS text cut mid-emoji) can't be UTF-8, so escape it as JS does
    body = LONE_SURROGATE.sub(lambda match: f"\\u{ord(match[0]):04x}", body)
    if len(body.encode()) > MAX_ENVELOPE_BYTES:
        raise ValueError(f"encode message {event['id']}: envelope is {len(body.encode())} bytes, over {MAX_ENVELOPE_BYTES}")
    return body


def decode(body: str, **delivery) -> Delivery:
    """Reads an envelope into a Delivery with the broker's attempt, deadline, and handle."""
    event = parse_json(body)
    if not isinstance(event, dict):
        raise ValueError("decode envelope: not an object")
    members = {name: value for name, value in event.items() if name != "data"}
    if not all(isinstance(value, str) for value in members.values()):
        raise ValueError("decode envelope: every attribute, extension, and data_base64 must be a string")
    for name in members.keys() - ATTRIBUTES:
        if not EXTENSION_NAME.fullmatch(name):
            raise ValueError(f"decode envelope: extension name {name!r} is not [a-z0-9]{{1,20}}")
    if members.get("specversion") != "1.0" or not all(members.get(name) for name in ("id", "source", "type")):
        raise ValueError("decode envelope: specversion 1.0, id, source, and type are required")
    if not RFC3339.fullmatch(members.get("time", "")):
        raise ValueError(f"decode envelope {members['id']}: time {members.get('time')!r} is not RFC 3339")
    if "data" in event and "data_base64" in event:
        raise ValueError(f"decode envelope {members['id']}: data and data_base64 are mutually exclusive")
    if "data_base64" in event:
        data = base64.b64decode(event["data_base64"], validate=True)
        # NOTE: validate still allows nonzero padding bits, so only canonical base64 round-trips
        if base64.b64encode(data).decode() != event["data_base64"]:
            raise ValueError(f"decode envelope {members['id']}: data_base64 is not canonical base64")
    elif "data" in event:
        data = json.dumps(event["data"], separators=(",", ":")).encode()
    else:
        data = None
    return Delivery(
        id=members["id"],
        source=members["source"],
        type=members["type"],
        content_type=members.get("datacontenttype", "application/json"),
        extensions={name: value for name, value in members.items() if name not in ATTRIBUTES},
        data=data,
        time=datetime.fromisoformat(members.get("time", "")),
        **delivery,
    )


def parse_json(text: str | bytes) -> object:
    """Parses JSON, rejecting NaN, Infinity, and numbers past float64's range as Go and TS do."""
    return json.loads(text, parse_constant=reject_number, parse_float=finite_float, parse_int=finite_int)


def reject_number(text: str) -> None:
    raise ValueError(f"JSON number {text} is not finite")


def finite_float(text: str) -> float:
    if not math.isfinite(number := float(text)):
        reject_number(text)
    return number


def finite_int(text: str) -> int:
    if not math.isfinite(float(text)):
        reject_number(text)
    return int(text)


def decode_rows(rows: Iterable[tuple[str, int, object]], deadline: datetime) -> tuple[list[Delivery], list[object]]:
    """Decodes (body, attempt, handle) rows, returning the deliveries and the handles of
    malformed messages, which adapters ack and log instead of retrying."""
    deliveries, malformed = [], []
    for body, attempt, handle in rows:
        try:
            deliveries.append(decode(body, attempt=attempt, deadline=deadline, handle=handle))
        except (ValueError, TypeError):
            log.exception("queue dropped a malformed message")
            malformed.append(handle)
    return deliveries, malformed


def query_params(parsed: SplitResult, *allowed: str) -> dict[str, str]:
    """Returns the URL's query, rejecting parameters outside allowed and repeated ones."""
    params = {}
    for name, values in parse_qs(parsed.query, keep_blank_values=True).items():
        if name not in allowed or len(values) != 1:
            raise ValueError(f"{parsed.scheme} URL: unexpected parameter {name!r}")
        params[name] = values[0]
    return params


def parse_lease(params: dict[str, str]) -> float:
    """Reads the required lease parameter in seconds, written like 500ms, 30s, 2m, or 1h."""
    match = DURATION.fullmatch(params.get("lease", ""))
    if match is None:
        raise ValueError(f"lease {params.get('lease')!r} must be a whole number of ms, s, m, or h")
    lease = int(match[1]) * DURATION_SECONDS[match[2]]
    if not 0 < lease <= 12 * 3600:
        raise ValueError(f"lease {params['lease']!r} must be more than 0 and at most 12h")
    return lease


def check_delay(delay: float) -> None:
    if not 0 <= delay <= MAX_DELAY:
        raise ValueError(f"delay {delay}s must be between 0 and {MAX_DELAY}s")


def delay_seconds(delay: float) -> int:
    """Rounds a checked delay up to whole seconds."""
    return math.ceil(delay)


def backoff(attempt: int) -> float:
    """The worker's retry delay after a failed attempt: 1 s, 2 s, 4 s, … up to MAX_DELAY."""
    return min(2.0 ** min(max(attempt - 1, 0), 10), MAX_DELAY)


def batches[T](items: list[T], size: Callable[[T], int], max_count: int, max_bytes: int) -> list[list[T]]:
    """Splits items into runs of at most max_count items and max_bytes total size."""
    result: list[list[T]] = []
    for item in items:
        if not result or len(result[-1]) == max_count or sum(map(size, result[-1])) + size(item) > max_bytes:
            result.append([])
        result[-1].append(item)
    return result
