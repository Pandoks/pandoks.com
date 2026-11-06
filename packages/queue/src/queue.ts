// Runs jobs from the queue_jobs table. Every rule is in queue.sql; this only waits, claims, heartbeats, runs and reports.
import type pg from 'pg';

// NOTE: PgDog parses a SELECT as a read, but every queue function writes
const PRIMARY = '/* pgdog_role: primary */ ';

export interface Job {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  group_key: string | null;
  attempt: number;
  reported?: boolean;
}

export type Handler = (job: Job) => Promise<void>;

type Db = Pick<pg.ClientBase, 'query'>;

// A handler error that retrying can't fix: the job goes dead at once.
export class Permanent extends Error {}

// A handler error to retry after the given seconds instead of the backoff.
export class RetryAfter extends Error {
  seconds: number;

  constructor(seconds: number, message: string) {
    super(message);
    this.seconds = seconds;
  }
}

// Adds a job that may run from runAt, or now, and returns its id. Pass a client in a transaction to commit it
// with the caller's writes.
export async function enqueue(
  db: Db,
  queue: string,
  payload: Record<string, unknown>,
  options: { runAt?: Date; groupKey?: string; maxAttempts?: number } = {}
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    PRIMARY + 'SELECT queue_enqueue($1, $2, $3, $4, $5) AS id',
    [queue, payload, options.runAt ?? null, options.groupKey ?? null, options.maxAttempts ?? null]
  );
  return rows[0].id;
}

// Deletes a job no worker is running, and reports whether it did.
export async function cancel(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query<{ cancelled: boolean }>(
    PRIMARY + 'SELECT queue_cancel($1) AS cancelled',
    [id]
  );
  return rows[0].cancelled;
}

// Deletes every job of queue and groupKey that no worker is running, and returns how many.
export async function cancelGroup(db: Db, queue: string, groupKey: string): Promise<number> {
  const { rows } = await db.query<{ cancelled: string }>(
    PRIMARY + 'SELECT queue_cancel_group($1, $2) AS cancelled',
    [queue, groupKey]
  );
  return Number(rows[0].cancelled);
}

// Ends the job in db's transaction, so it commits with the handler's writes. False means the lease was lost: roll back.
export async function complete(db: Db, job: Job): Promise<boolean> {
  const { rows } = await db.query<{ completed: boolean }>(
    PRIMARY + 'SELECT queue_complete($1, $2) AS completed',
    [job.id, job.attempt]
  );
  job.reported = rows[0].completed;
  return rows[0].completed;
}

// Runs jobs one at a time until the connection fails. It LISTENs and heartbeats on db, so the handler writes
// through another client.
export async function work(
  db: pg.Client,
  queue: string,
  worker: string,
  handle: Handler,
  lease = 30
) {
  let notifications = 0;
  let wakeUp = () => {};
  db.on('notification', () => {
    notifications++;
    wakeUp();
  });
  await db.query(`LISTEN ${db.escapeIdentifier(`queue_${queue}`)}`);
  for (;;) {
    const {
      rows: [job]
    } = await db.query<Job>(
      PRIMARY +
        'SELECT id, queue, payload, group_key, attempts AS attempt FROM queue_claim($1, $2, $3)',
      [queue, worker, lease]
    );
    if (job) {
      await run(db, job, handle, lease);
      continue;
    }
    const {
      rows: [{ seconds }]
    } = await db.query<{ seconds: number }>(
      PRIMARY + 'SELECT queue_wait_seconds($1, $2) AS seconds',
      [queue, lease]
    );
    // NOTE: a NOTIFY that arrived during the two queries above means a job may already be due, so claim again
    if (notifications === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeUp = () => {};
    }
    notifications = 0;
  }
}

async function run(db: pg.Client, job: Job, handle: Handler, lease: number): Promise<void> {
  // NOTE: a promise can't be stopped, so a lost lease is only logged; the fenced report changes nothing
  let extending = Promise.resolve();
  const extend = () => {
    extending = db
      .query<{ extended: boolean }>(PRIMARY + 'SELECT queue_extend($1, $2, $3) AS extended', [
        job.id,
        job.attempt,
        lease
      ])
      .then(({ rows: [{ extended }] }) => {
        if (!extended) {
          console.warn(`lease lost while running job ${job.id} attempt ${job.attempt}`);
        }
      });
  };
  const heartbeat = setInterval(extend, (lease / 3) * 1000);
  let query: string;
  let params: unknown[];
  try {
    await handle(job);
    if (job.reported) return;
    query = 'SELECT queue_complete($1, $2) AS reported';
    params = [job.id, job.attempt];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Permanent) {
      query = 'SELECT queue_fail($1, $2, $3) AS reported';
      params = [job.id, job.attempt, message];
    } else if (error instanceof RetryAfter) {
      query = 'SELECT queue_retry($1, $2, $3, $4) AS reported';
      params = [job.id, job.attempt, message, error.seconds];
    } else {
      query = 'SELECT queue_retry($1, $2, $3) AS reported';
      params = [job.id, job.attempt, message];
    }
  } finally {
    clearInterval(heartbeat);
    // NOTE: one query at a time on db, so the report waits for a heartbeat in flight
    await extending;
  }
  const {
    rows: [{ reported }]
  } = await db.query<{ reported: boolean }>(PRIMARY + query, params);
  if (!reported) {
    console.warn(`lease lost before the report for job ${job.id} attempt ${job.attempt}`);
  }
}
