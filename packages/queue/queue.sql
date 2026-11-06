-- Job queue shared by every app: one table and the functions workers call. Every rule lives here: the lease,
-- the retry backoff, the attempt limit, the wake-up. Clients only wait, claim, heartbeat, run and report.
-- Objects live in public with a queue_ prefix, since admin may create only in public (#252).
-- NOTE: every pod start reruns this file, so changes stay additive and idempotent: ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE, and DROP FUNCTION IF EXISTS before a signature changes.
SELECT pg_advisory_xact_lock(hashtext('queue_migrate'));
-- NOTE: CREATE INDEX and CREATE TRIGGER lock queue_jobs even when nothing changes, and every queue write waits behind
-- them, so a migrate stuck behind an open transaction fails instead of stalling the queue
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS queue_jobs (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue        text        NOT NULL,
  payload      jsonb       NOT NULL,
  -- NOTE: lets a caller cancel every waiting job of one request, like a notification's chunks and retries
  group_key    text,
  -- NOTE: a finished or cancelled job is deleted; a dead one stays for a human to inspect
  state        text        NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'dead')),
  -- NOTE: set on a running job; its retry, release or lost lease deletes it instead of running it again
  cancelled    boolean     NOT NULL DEFAULT false,
  -- When a queued job may run. While running, the lease end: after it, another worker may claim the job.
  available_at timestamptz NOT NULL,
  attempts     int         NOT NULL DEFAULT 0,
  max_attempts int         NOT NULL CHECK (max_attempts > 0),
  worker       text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queue_jobs_due ON queue_jobs (queue, available_at) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS queue_jobs_group_key ON queue_jobs (queue, group_key) WHERE group_key IS NOT NULL;

-- Wakes the queue's LISTENing workers at commit, so a rolled-back enqueue wakes nobody. Postgres folds
-- identical notifications in one transaction, so a batch enqueue sends one.
CREATE OR REPLACE FUNCTION queue_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('queue_' || NEW.queue, '');
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER queue_jobs_queued AFTER INSERT OR UPDATE OF state ON queue_jobs
  FOR EACH ROW WHEN (NEW.state = 'queued') EXECUTE FUNCTION queue_notify();

CREATE OR REPLACE FUNCTION queue_enqueue(
  queue_name text, job_payload jsonb, run_at timestamptz DEFAULT NULL, job_group_key text DEFAULT NULL,
  job_max_attempts int DEFAULT NULL
) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO queue_jobs (queue, payload, available_at, group_key, max_attempts)
  VALUES (queue_name, job_payload, coalesce(run_at, now()), job_group_key, coalesce(job_max_attempts, 5))
  RETURNING id;
$$;

-- Claims the queue's next due job for a lease. A job whose lease ran out on its last attempt is marked dead here,
-- and a cancelled one is deleted, instead of being run again. Both skip locked rows, so an open handler
-- transaction can't stall the queue's claims.
CREATE OR REPLACE FUNCTION queue_claim(queue_name text, worker_name text, lease_seconds double precision)
RETURNS SETOF queue_jobs LANGUAGE sql AS $$
  WITH expired AS (
    SELECT id, cancelled FROM queue_jobs
    WHERE queue = queue_name AND state = 'running' AND available_at <= now() AND (cancelled OR attempts >= max_attempts)
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM queue_jobs WHERE id IN (SELECT id FROM expired WHERE cancelled)
  ), exhausted AS (
    UPDATE queue_jobs SET state = 'dead', last_error = 'lease expired on the last attempt'
    WHERE id IN (SELECT id FROM expired WHERE NOT cancelled)
  ), next AS (
    SELECT id FROM queue_jobs
    WHERE queue = queue_name AND state IN ('queued', 'running') AND available_at <= now() AND attempts < max_attempts
      AND NOT cancelled
    ORDER BY available_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE queue_jobs SET state = 'running', attempts = attempts + 1, worker = worker_name,
                        available_at = now() + make_interval(secs => lease_seconds)
  FROM next WHERE queue_jobs.id = next.id
  RETURNING queue_jobs.*;
$$;

-- The attempt argument fences every report: once a lease runs out and another worker claims the job,
-- the first worker's extend, complete, retry and fail return false and change nothing.
CREATE OR REPLACE FUNCTION queue_extend(job_id bigint, attempt int, lease_seconds double precision) RETURNS boolean LANGUAGE sql AS $$
  WITH extended AS (
    UPDATE queue_jobs SET available_at = now() + make_interval(secs => lease_seconds)
    WHERE id = job_id AND attempts = attempt AND state = 'running'
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM extended);
$$;

-- Call it in the handler's own transaction to commit the job's end with the handler's writes and follow-up jobs.
CREATE OR REPLACE FUNCTION queue_complete(job_id bigint, attempt int) RETURNS boolean LANGUAGE sql AS $$
  WITH done AS (
    DELETE FROM queue_jobs WHERE id = job_id AND attempts = attempt AND state = 'running'
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM done);
$$;

-- Retries after retry_after_s seconds, or 2^(attempts-1) seconds up to an hour when the handler gives none. Dead
-- after max_attempts, and deleted once cancelled.
CREATE OR REPLACE FUNCTION queue_retry(job_id bigint, attempt int, error_text text, retry_after_s double precision DEFAULT NULL)
RETURNS boolean LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM queue_jobs WHERE id = job_id AND attempts = attempt AND state = 'running' AND cancelled
    RETURNING 1
  ), retried AS (
    UPDATE queue_jobs SET
      state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
      available_at = now() + make_interval(secs => coalesce(retry_after_s, least(power(2, attempts - 1), 3600))),
      last_error = error_text
    WHERE id = job_id AND attempts = attempt AND state = 'running' AND NOT cancelled
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM deleted) OR EXISTS (SELECT 1 FROM retried);
$$;

CREATE OR REPLACE FUNCTION queue_fail(job_id bigint, attempt int, error_text text) RETURNS boolean LANGUAGE sql AS $$
  WITH failed AS (
    UPDATE queue_jobs SET state = 'dead', last_error = error_text
    WHERE id = job_id AND attempts = attempt AND state = 'running'
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM failed);
$$;

-- Hands a job back without spending its attempt, for a worker that stops before its handler finishes. Deletes it
-- once cancelled.
CREATE OR REPLACE FUNCTION queue_release(job_id bigint, attempt int) RETURNS boolean LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM queue_jobs WHERE id = job_id AND attempts = attempt AND state = 'running' AND cancelled
    RETURNING 1
  ), released AS (
    UPDATE queue_jobs SET state = 'queued', attempts = attempts - 1, available_at = now(), worker = NULL
    WHERE id = job_id AND attempts = attempt AND state = 'running' AND NOT cancelled
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM deleted) OR EXISTS (SELECT 1 FROM released);
$$;

-- Cancels a job so it never runs again: deletes it, or marks it while a worker holds its lease, so its handler
-- finishes this run.
CREATE OR REPLACE FUNCTION queue_cancel(job_id bigint) RETURNS boolean LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM queue_jobs WHERE id = job_id AND (state = 'queued' OR state = 'running' AND available_at <= now())
    RETURNING 1
  ), marked AS (
    UPDATE queue_jobs SET cancelled = true WHERE id = job_id AND state = 'running' AND available_at > now() AND NOT cancelled
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM deleted) OR EXISTS (SELECT 1 FROM marked);
$$;

CREATE OR REPLACE FUNCTION queue_cancel_group(queue_name text, key text) RETURNS bigint LANGUAGE sql AS $$
  WITH deleted AS (
    DELETE FROM queue_jobs
    WHERE queue = queue_name AND group_key = key AND (state = 'queued' OR state = 'running' AND available_at <= now())
    RETURNING 1
  ), marked AS (
    UPDATE queue_jobs SET cancelled = true
    WHERE queue = queue_name AND group_key = key AND state = 'running' AND available_at > now() AND NOT cancelled
    RETURNING 1
  ) SELECT (SELECT count(*) FROM deleted) + (SELECT count(*) FROM marked);
$$;

-- Seconds an idle worker waits for a NOTIFY: until the queue's next due job or lease end, at most max_seconds.
-- NOTE: at least 0.1 s, since a due row that queue_claim skips, like one an open transaction locks, would make
-- it 0 and spin every idle worker until that transaction ends
CREATE OR REPLACE FUNCTION queue_wait_seconds(queue_name text, max_seconds double precision) RETURNS double precision
LANGUAGE sql STABLE AS $$
  SELECT greatest(0.1, extract(epoch FROM least(min(available_at), now() + make_interval(secs => max_seconds)) - now()))::double precision
  FROM queue_jobs WHERE queue = queue_name AND state IN ('queued', 'running');
$$;
