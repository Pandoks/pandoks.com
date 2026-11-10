import threading
import unittest
from datetime import UTC, datetime, timedelta

from pandoks_queue import MAX_DELAY, Delivery, Permanent, RetryAfter, Worker


class RecordingQueue:
    """Hands out its deliveries once and records how the worker settles them."""

    def __init__(self, deliveries, stop):
        self.deliveries, self.stop = deliveries, stop
        self.maxes, self.acked, self.retried = [], [], {}
        self.lock = threading.Lock()

    def receive(self, max):
        with self.lock:
            self.maxes.append(max)
            result, self.deliveries = self.deliveries[:max], self.deliveries[max:]
        if not result:
            self.stop.wait()
        return result

    def ack(self, *deliveries):
        with self.lock:
            self.acked += [delivery.id for delivery in deliveries]

    def retry(self, delay, *deliveries):
        with self.lock:
            self.retried |= {delivery.id: delay for delivery in deliveries}


class StoppingQueue(RecordingQueue):
    """Sets stop as each receive returns, like a shutdown racing it."""

    def receive(self, max):
        received = super().receive(max)
        self.stop.set()
        return received


class WorkerTest(unittest.TestCase):
    def test_worker_settles_each_outcome(self):
        stop = threading.Event()
        deadline = datetime.now(UTC) + timedelta(minutes=1)
        ids = ["ok", "permanent", "retry-after", "expired", "failed", "shutdown"]
        queue = RecordingQueue(
            [Delivery(id=id, source="//test", type="test", time=deadline, attempt=3, deadline=deadline) for id in ids],
            stop,
        )

        def handle(delivery):
            match delivery.id:
                case "permanent":
                    raise Permanent("malformed")
                case "retry-after":
                    raise RetryAfter(3600, "rate limited")
                case "expired":
                    raise RetryAfter(-1, "retry date passed")
                case "failed":
                    raise RuntimeError("transient")
                case "shutdown":
                    stop.set()
                    raise RuntimeError("stopped")

        worker = Worker(queue, handle, concurrency=2)
        with self.assertLogs("pandoks_queue", "WARNING"):
            worker.run(stop)
        self.assertCountEqual(queue.acked, ["ok", "permanent"])
        self.assertEqual(queue.retried, {"retry-after": MAX_DELAY, "expired": 0, "failed": 4, "shutdown": 4})
        self.assertTrue(all(1 <= max <= 2 for max in queue.maxes), queue.maxes)

    def test_worker_warns_only_past_half_a_short_lease(self):
        stop = threading.Event()
        deadline = datetime.now(UTC) + timedelta(seconds=5)
        queue = RecordingQueue([Delivery(id="quick", source="//test", type="test", time=deadline, attempt=1, deadline=deadline)], stop)

        def handle(delivery):
            stop.set()

        with self.assertNoLogs("pandoks_queue", "WARNING"):
            Worker(queue, handle, concurrency=1).run(stop)
        self.assertEqual(queue.acked, ["quick"])

    def test_worker_releases_what_it_receives_after_stop(self):
        stop = threading.Event()
        deadline = datetime.now(UTC) + timedelta(minutes=1)
        queue = StoppingQueue([Delivery(id="late", source="//test", type="test", time=deadline, attempt=1, deadline=deadline)], stop)
        handled = []
        Worker(queue, handled.append, concurrency=1).run(stop)
        self.assertEqual((handled, queue.acked, queue.retried), ([], [], {"late": 0}))
