"""Valkey cluster queues and topics built from the shared Lua scripts in packages/queue/valkey."""

import re
import secrets
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import SplitResult, unquote

from valkey.cluster import ValkeyCluster
from valkey.exceptions import ResponseError

from pandoks_queue.envelope import (
    Delivery,
    Message,
    check_delay,
    decode_rows,
    decodes,
    delay_milliseconds,
    encode,
    parse_lease,
    query_params,
)

SCRIPTS = Path(__file__).resolve().parents[2] / "valkey"
GROUP = "workers"
EMPTY_POLL_DELAY = 0.1
WHOLE_NUMBER = re.compile(r"\d+", re.ASCII)


def valkey_name(parsed: SplitResult) -> str:
    """Reads <name> from a valkey://[user:password@]host:port/<name> URL. Check it before anything
    that echoes the URL: an unescaped /, ?, or # in the password leaves no valid name."""
    name = unquote(parsed.path.removeprefix("/"))
    parts = (parsed.path, parsed.username or "", parsed.password or "")
    try:
        port = parsed.port
    except ValueError:
        # NOTE: its error carries the port, which is the password when the URL has no @
        port = None
    if (
        not parsed.hostname
        or not name
        or any(character in name for character in "{}/")
        or not all(map(decodes, parts))
        or port is None
    ):
        raise ValueError("valkey URL must be valkey://[user:password@]host:port/<name>")
    return name


def valkey_client(parsed: SplitResult) -> ValkeyCluster:
    return ValkeyCluster(
        host=parsed.hostname,
        port=parsed.port,
        username=unquote(parsed.username or "") or None,
        password=unquote(parsed.password or "") or None,
    )


def open_queue(parsed: SplitResult) -> ValkeyQueue:
    name = valkey_name(parsed)
    params = query_params(parsed, "lease", "max_attempts", "subscription")
    lease = parse_lease(parsed, params)
    max_attempts = params.get("max_attempts", "")
    if not WHOLE_NUMBER.fullmatch(max_attempts) or not 1 <= int(max_attempts) < 2**63:
        raise ValueError(f"valkey URL: max_attempts {max_attempts!r} must be from 1 to 2^63-1")
    client = valkey_client(parsed)
    prefix = "{" + name + "}"
    if (subscription := params.get("subscription")) is not None:
        if not subscription:
            client.close()
            raise ValueError("valkey URL: subscription is empty")
        prefix += ":" + subscription
        try:
            client.sadd("{" + name + "}:subscriptions", subscription)
        except BaseException:
            client.close()
            raise
    return ValkeyQueue(client, prefix, lease, int(max_attempts))


def open_topic(parsed: SplitResult) -> ValkeyTopic:
    name = valkey_name(parsed)
    query_params(parsed)
    return ValkeyTopic(valkey_client(parsed), name)


class ValkeyQueue:
    """Keeps a queue's stream, delayed retries, dead letters, and reclaim cursor under one hash tag."""

    def __init__(self, client: ValkeyCluster, prefix: str, lease: float, max_attempts: int):
        self.client, self.lease, self.max_attempts = client, lease, max_attempts
        self.keys = [prefix + ":stream", prefix + ":delayed", prefix + ":dlq", prefix + ":reclaim"]
        self.consumer = secrets.token_hex(8)
        self.send_script = client.register_script((SCRIPTS / "send.lua").read_text())
        self.receive_script = client.register_script((SCRIPTS / "receive.lua").read_text())
        self.retry_script = client.register_script((SCRIPTS / "retry.lua").read_text())
        self.close_script = client.register_script((SCRIPTS / "close.lua").read_text())
        self.ack_script = client.register_script((SCRIPTS / "ack.lua").read_text())

    def send(self, *messages: Message) -> None:
        sent_at = datetime.now(UTC)
        args = []
        for message in messages:
            body = encode(message, sent_at)
            args += [delay_milliseconds(message.delay), body]
        self.send_script(keys=self.keys[:2], args=args)

    def receive(self, max: int) -> list[Delivery]:
        if max < 1:
            raise ValueError(f"receive from Valkey: max {max} must be at least 1")
        args = [GROUP, self.consumer, max, round(self.lease * 1000), self.max_attempts]
        rows = self.receive_script(keys=self.keys, args=args)
        # NOTE: the lease starts when the script runs, which can be well after the call on a busy server
        deadline = datetime.now(UTC) + timedelta(seconds=self.lease)
        deliveries, malformed = decode_rows(((body, int(attempt), stream_id) for stream_id, body, attempt in rows), deadline)
        self._delete(malformed)
        if not rows:
            time.sleep(EMPTY_POLL_DELAY)
        return deliveries

    def _delete(self, stream_ids: list) -> None:
        if stream_ids:
            self.ack_script(keys=self.keys[:1], args=[GROUP, *stream_ids])

    def ack(self, *deliveries: Delivery) -> None:
        self._delete([delivery.handle for delivery in deliveries])

    def retry(self, delay: float, *deliveries: Delivery) -> None:
        check_delay(delay)
        if deliveries:
            args = [GROUP, delay_milliseconds(delay), self.max_attempts]
            for delivery in deliveries:
                args += [delivery.handle, delivery.attempt]
            self.retry_script(keys=self.keys, args=args)

    def close(self) -> None:
        try:
            self.close_script(keys=self.keys[:1], args=[GROUP, self.consumer])
        finally:
            self.client.close()


class ValkeyTopic:
    """Fans each message out to every subscription registered in {<topic>}:subscriptions."""

    def __init__(self, client: ValkeyCluster, name: str):
        self.client, self.name = client, name
        self.publish_script = client.register_script((SCRIPTS / "publish.lua").read_text())

    def publish(self, *messages: Message) -> None:
        if any(message.delay for message in messages):
            raise ValueError("publish to Valkey: topics take no delay")
        sent_at = datetime.now(UTC)
        for body in [encode(message, sent_at) for message in messages]:
            self._publish(body)

    def _publish(self, body: str) -> None:
        """Rereads the subscriptions when publish.lua reports they changed since the last read."""
        subscriptions_key = "{" + self.name + "}:subscriptions"
        for _ in range(3):
            subscriptions = sorted(name.decode() for name in self.client.smembers(subscriptions_key))
            keys = [subscriptions_key, *("{" + self.name + "}:" + name + ":stream" for name in subscriptions)]
            try:
                self.publish_script(keys=keys, args=[body])
                return
            except ResponseError as error:
                if "STALE" not in str(error):
                    raise
        raise RuntimeError(f"publish to Valkey topic {self.name}: subscriptions kept changing")

    def close(self) -> None:
        self.client.close()
