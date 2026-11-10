"""Runs a handler on deliveries with the same settle rules as the Go and TS workers."""

import math
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from pandoks_queue.envelope import MAX_DELAY, Delivery, Queue, backoff, log

HANDLER_MARGIN = timedelta(seconds=10)
POLL_ERROR_DELAY = 1.0


class Permanent(Exception):
    """A handler error the worker acks instead of retrying, like a malformed payload."""


class RetryAfter(Exception):
    """A handler error the worker retries after delay seconds, clamped to 0 through MAX_DELAY. A NaN
    delay raises ValueError instead, which the worker retries after backoff like any other error."""

    def __init__(self, delay: float, *args: object):
        if math.isnan(delay):
            raise ValueError("RetryAfter delay is NaN")
        super().__init__(*args)
        self.delay = delay


@dataclass
class Worker:
    """Runs handle on up to concurrency deliveries at once in threads. A handler that returns is
    acked; Permanent is acked and logged; RetryAfter is retried after its delay; any other
    exception is retried after backoff. Python can't stop a running handler, so one that runs
    past 10 s before its deadline (halfway there for a shorter lease) is logged, and the broker
    may redeliver it meanwhile. run returns once stop is set, what its last receive returned is
    released, and the running handlers have settled."""

    queue: Queue
    handle: Callable[[Delivery], None]
    concurrency: int

    def run(self, stop: threading.Event) -> None:
        if self.concurrency < 1:
            raise ValueError("queue worker: concurrency must be at least 1")
        slots = threading.BoundedSemaphore(self.concurrency)
        with ThreadPoolExecutor(self.concurrency) as pool:
            while slots.acquire() and not stop.is_set():
                free = 1
                while free < self.concurrency and slots.acquire(blocking=False):
                    free += 1
                try:
                    deliveries = self.queue.receive(free)
                except Exception:
                    log.exception("queue receive failed")
                    deliveries = []
                    stop.wait(POLL_ERROR_DELAY)
                if stop.is_set():
                    self._release(deliveries)
                    deliveries = []
                for _ in range(free - len(deliveries)):
                    slots.release()
                for delivery in deliveries:
                    pool.submit(self._process, delivery, slots)
            slots.release()

    def _release(self, deliveries: list[Delivery]) -> None:
        """Returns deliveries received after stop to the queue without handling them."""
        try:
            self.queue.retry(0, *deliveries)
        except Exception:
            log.exception("queue release failed")

    def _process(self, delivery: Delivery, slots: threading.BoundedSemaphore) -> None:
        try:
            self._settle(delivery)
        except Exception:
            log.exception("queue settle of %s failed", delivery.id)
        finally:
            slots.release()

    def _settle(self, delivery: Delivery) -> None:
        name = f"{delivery.id} ({delivery.type}) attempt {delivery.attempt}"
        handler_deadline = delivery.deadline - min(HANDLER_MARGIN, (delivery.deadline - datetime.now(UTC)) / 2)
        try:
            self.handle(delivery)
        except Permanent:
            log.exception("queue message %s failed permanently", name)
            return self.queue.ack(delivery)
        except RetryAfter as error:
            log.warning("queue message %s retried in %ss: %s", name, error.delay, error)
            return self.queue.retry(min(max(error.delay, 0), MAX_DELAY), delivery)
        except Exception:
            log.exception("queue message %s failed", name)
            return self.queue.retry(backoff(delivery.attempt), delivery)
        finally:
            if datetime.now(UTC) > handler_deadline:
                log.warning("queue handler for %s ran past %s before its deadline", name, delivery.deadline - handler_deadline)
        self.queue.ack(delivery)
