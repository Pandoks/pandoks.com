"""Runs jobs from the queue_jobs table. Every rule is in queue.sql; this only waits, claims, heartbeats, runs and reports."""

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

# NOTE: PgDog parses a SELECT as a read, but every queue function writes
PRIMARY = "/* pgdog_role: primary */ "


@dataclass
class Job:
    id: int
    queue: str
    payload: dict
    group_key: str | None
    attempt: int
    reported: bool = False

    def complete(self, db: psycopg.Connection) -> bool:
        """Ends the job in db's transaction, so it commits with the handler's writes. False means the lease was lost: roll back."""
        self.reported = db.execute(PRIMARY + "SELECT queue_complete(%s, %s)", (self.id, self.attempt)).fetchone()[0]
        return self.reported


class Permanent(Exception):
    """A handler error that retrying can't fix: the job goes dead at once."""


class RetryAfter(Exception):
    """A handler error to retry after the given seconds instead of the backoff."""

    def __init__(self, seconds: float, message: str):
        super().__init__(message)
        self.seconds = seconds


def enqueue(
    db: psycopg.Connection,
    queue: str,
    payload: dict,
    run_at: datetime | None = None,
    group_key: str | None = None,
    max_attempts: int | None = None,
) -> int:
    """Adds a job that may run from run_at, or now, and returns its id. Pass a connection in a transaction to commit it with the caller's writes."""
    return db.execute(
        PRIMARY + "SELECT queue_enqueue(%s, %s, %s, %s, %s)", (queue, Jsonb(payload), run_at, group_key, max_attempts)
    ).fetchone()[0]


def cancel(db: psycopg.Connection, job_id: int) -> bool:
    """Makes a job never run again, and reports whether it did. A job a worker is running finishes this run."""
    return db.execute(PRIMARY + "SELECT queue_cancel(%s)", (job_id,)).fetchone()[0]


def cancel_group(db: psycopg.Connection, queue: str, group_key: str) -> int:
    """Cancels every job of queue and group_key like cancel, and returns how many."""
    return db.execute(PRIMARY + "SELECT queue_cancel_group(%s, %s)", (queue, group_key)).fetchone()[0]


def work(conninfo: str, queue: str, worker: str, handle: Callable[[Job], None], lease: float = 30) -> None:
    """Runs jobs one at a time until the connection fails. It opens a connection of its own, since it LISTENs
    and heartbeats on it, so the handler writes through another connection."""
    if lease <= 0:
        raise ValueError(f"the lease is {lease} s, but it must be positive")
    with psycopg.connect(conninfo, autocommit=True) as conn:
        conn.execute(sql.SQL("LISTEN {}").format(sql.Identifier(f"queue_{queue}")))
        while True:
            row = conn.execute(
                PRIMARY + "SELECT id, queue, payload, group_key, attempts FROM queue_claim(%s, %s, %s)", (queue, worker, lease)
            ).fetchone()
            if row is None:
                seconds = conn.execute(PRIMARY + "SELECT queue_wait_seconds(%s, %s)", (queue, lease)).fetchone()[0]
                for _ in conn.notifies(timeout=seconds, stop_after=1):
                    pass
                continue
            _run(conn, Job(*row), handle, lease)


def _run(conn: psycopg.Connection, job: Job, handle: Callable[[Job], None], lease: float) -> None:
    stop = threading.Event()

    # NOTE: a thread can't stop the handler, so a lost lease is only logged; the fenced report changes nothing.
    # A failed extend doesn't mean the lease is lost, so the heartbeat keeps ticking. Once complete deletes the job
    # in the handler's transaction, an extend would wait on its row lock and find no row.
    def extend() -> None:
        while not stop.wait(lease / 3) and not job.reported:
            try:
                extended = conn.execute(PRIMARY + "SELECT queue_extend(%s, %s, %s)", (job.id, job.attempt, lease)).fetchone()[0]
            except psycopg.Error as error:
                logging.warning("heartbeat failed for job %s attempt %s: %s", job.id, job.attempt, error)
                continue
            if not extended:
                if not job.reported:
                    logging.warning("lease lost while running job %s attempt %s", job.id, job.attempt)
                return

    heartbeat = threading.Thread(target=extend, daemon=True)
    heartbeat.start()
    try:
        handle(job)
    except Permanent as error:
        query, args = "SELECT queue_fail(%s, %s, %s)", (job.id, job.attempt, str(error))
    except RetryAfter as error:
        query, args = "SELECT queue_retry(%s, %s, %s, %s)", (job.id, job.attempt, str(error), error.seconds)
    except Exception as error:
        query, args = "SELECT queue_retry(%s, %s, %s)", (job.id, job.attempt, str(error))
    else:
        if job.reported:
            return
        query, args = "SELECT queue_complete(%s, %s)", (job.id, job.attempt)
    finally:
        stop.set()
        heartbeat.join()
    if not conn.execute(PRIMARY + query, args).fetchone()[0]:
        logging.warning("lease lost before the report for job %s attempt %s", job.id, job.attempt)
