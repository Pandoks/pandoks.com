"""Tests the Python client's own code against Postgres; queue_test.go covers the SQL rules. Reads the PG* variables."""

import threading
import time
import unittest
from pathlib import Path

import psycopg

from pandoks_queue import Job, Permanent, RetryAfter, enqueue, work

db: psycopg.Connection


def setUpModule() -> None:
    global db
    db = psycopg.connect("", autocommit=True)
    db.execute((Path(__file__).parents[2] / "queue.sql").read_text())


def tearDownModule() -> None:
    db.close()


def start_worker(queue: str, handle, lease: float = 30, conninfo: str = "") -> None:
    """Runs a worker until the test process exits."""
    threading.Thread(target=work, args=(conninfo, queue, "worker", handle, lease), daemon=True).start()


def wait_for(condition, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError(f"condition not met within {timeout} s")
        time.sleep(0.02)


def row(job_id: int) -> tuple | None:
    """Reads a job's state, attempts, last error and seconds until it is available, or None once it is deleted."""
    return db.execute(
        "SELECT state, attempts, last_error, extract(epoch FROM available_at - now())::float FROM queue_jobs WHERE id = %s",
        (job_id,),
    ).fetchone()


class QueueTest(unittest.TestCase):
    def setUp(self) -> None:
        # Named after the test and emptied, so reruns against the same database start clean
        self.queue = f"py-{self._testMethodName}"
        db.execute("DELETE FROM queue_jobs WHERE queue LIKE %s || '%%'", (self.queue,))

    def test_error_mapping(self) -> None:
        rows = {}
        snapshot = threading.Event()

        def handle(job: Job) -> None:
            match job.payload["raise"]:
                case "error":
                    raise ValueError("boom")
                case "retry_after":
                    raise RetryAfter(10, "rate limited")
                case "permanent":
                    raise Permanent("bad payload")
            # NOTE: one job at a time, so the jobs before this one are already reported
            rows.update({job_id: row(job_id) for job_id in job.payload["jobs"]})
            snapshot.set()

        errors = [enqueue(db, self.queue, {"raise": kind}) for kind in ("error", "retry_after", "permanent")]
        enqueue(db, self.queue, {"raise": None, "jobs": errors})
        start_worker(self.queue, handle)
        self.assertTrue(snapshot.wait(10))

        state, attempts, last_error, seconds = rows[errors[0]]
        self.assertEqual((state, attempts, last_error), ("queued", 1, "boom"))
        self.assertTrue(0.5 < seconds <= 1, f"backoff of {seconds} s, want 1")
        state, attempts, last_error, seconds = rows[errors[1]]
        self.assertEqual((state, attempts, last_error), ("queued", 1, "rate limited"))
        self.assertTrue(9.5 < seconds <= 10, f"retry after {seconds} s, want 10")
        state, attempts, last_error, _ = rows[errors[2]]
        self.assertEqual((state, attempts, last_error), ("dead", 1, "bad payload"))

    def test_heartbeat_keeps_a_long_job(self) -> None:
        lease = 1
        starts = 0
        lock = threading.Lock()

        def handle(job: Job) -> None:
            nonlocal starts
            with lock:
                starts += 1
            time.sleep(3 * lease)

        start_worker(self.queue, handle, lease)
        start_worker(self.queue, handle, lease)
        job_id = enqueue(db, self.queue, {})
        wait_for(lambda: row(job_id) is None, 10 * lease)
        self.assertEqual(starts, 1)

    def test_wake_on_the_queues_channel(self) -> None:
        started = []
        start = threading.Event()

        def handle(job: Job) -> None:
            started.append(time.monotonic())
            start.set()

        start_worker(self.queue, handle)
        # NOTE: the first job proves the worker runs; after it the worker idles, waiting up to the 30 s lease
        enqueue(db, self.queue, {})
        self.assertTrue(start.wait(10))
        start.clear()
        time.sleep(0.2)

        enqueued = time.monotonic()
        enqueue(db, self.queue, {})
        self.assertTrue(start.wait(1), "an idle worker didn't start a new job within 1 s")
        self.assertLess(started[-1] - enqueued, 1)

    def test_complete_in_the_handlers_transaction(self) -> None:
        app = psycopg.connect("", autocommit=True)
        self.addCleanup(app.close)
        done = threading.Event()

        def handle(job: Job) -> None:
            if job.payload.get("last"):
                done.set()
                return
            with app.transaction():
                enqueue(app, f"{self.queue}-followup", {"parent": job.id}, group_key=job.group_key)
                if not job.complete(app):
                    raise psycopg.Rollback()
                # NOTE: lets a heartbeat tick land between complete and the commit
                time.sleep(0.2)

        start_worker(self.queue, handle, lease=0.3)
        with self.assertNoLogs(level="WARNING"):
            job_id = enqueue(db, self.queue, {}, group_key="group")
            # NOTE: one job at a time, so once this one runs the first is reported
            enqueue(db, self.queue, {"last": True})
            self.assertTrue(done.wait(10))
        self.assertIsNone(row(job_id))
        followups = db.execute(
            "SELECT count(*) FROM queue_jobs WHERE queue = %s AND group_key = 'group' AND (payload->>'parent')::bigint = %s",
            (f"{self.queue}-followup", job_id),
        ).fetchone()[0]
        self.assertEqual(followups, 1)

    def test_failed_heartbeat_is_a_lost_lease(self) -> None:
        app = psycopg.connect("", autocommit=True)
        self.addCleanup(app.close)
        done = threading.Event()

        # NOTE: holds the job's row lock past the worker's lock_timeout, so its heartbeats fail
        def handle(job: Job) -> None:
            with app.transaction():
                app.execute("SELECT FROM queue_jobs WHERE id = %s FOR UPDATE", (job.id,))
                time.sleep(0.5)
            done.set()

        start_worker(self.queue, handle, lease=0.3, conninfo="options='-c lock_timeout=100'")
        with self.assertLogs(level="WARNING") as logs:
            enqueue(db, self.queue, {})
            self.assertTrue(done.wait(10))
        self.assertEqual(len(logs.output), 1, logs.output)
        self.assertIn("lease lost while running", logs.output[0])
