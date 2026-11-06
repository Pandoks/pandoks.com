// Tests the TS client's own code against Postgres; queue_test.go covers the SQL rules. Reads the PG* variables.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { complete, enqueue, Permanent, RetryAfter, work, type Handler } from './queue.ts';

const clients: pg.Client[] = [];
let db: pg.Client;

async function connect(config?: pg.ClientConfig) {
  const client = new pg.Client(config);
  await client.connect();
  clients.push(client);
  return client;
}

beforeAll(async () => {
  db = await connect();
  await db.query(readFileSync(new URL('../queue.sql', import.meta.url), 'utf8'));
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end()));
});

// Names a queue after the test and empties it, so reruns against the same database start clean.
async function newQueue(name: string) {
  const queue = `ts-${name}`;
  await db.query(`DELETE FROM queue_jobs WHERE queue LIKE $1 || '%'`, [queue]);
  return queue;
}

// Runs a worker until the clients end after every test.
async function startWorker(queue: string, handle: Handler, lease = 30, config?: pg.ClientConfig) {
  void work(await connect(config), queue, 'worker', handle, lease).catch(() => {});
}

interface Row {
  state: string;
  attempts: number;
  last_error: string | null;
  seconds: number;
}

async function row(id: string): Promise<Row | undefined> {
  const { rows } = await db.query<Row>(
    'SELECT state, attempts, last_error, extract(epoch FROM available_at - now())::float AS seconds FROM queue_jobs WHERE id = $1',
    [id]
  );
  return rows[0];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('maps handler errors to retry, retry-after and dead', async () => {
  const queue = await newQueue('error-mapping');
  const errors = [
    await enqueue(db, queue, { raise: 'error' }),
    await enqueue(db, queue, { raise: 'retry-after' }),
    await enqueue(db, queue, { raise: 'permanent' })
  ];
  await enqueue(db, queue, { raise: null });
  const { promise: snapshot, resolve } = Promise.withResolvers<(Row | undefined)[]>();
  await startWorker(queue, async (job) => {
    if (job.payload.raise === 'error') throw new Error('boom');
    if (job.payload.raise === 'retry-after') throw new RetryAfter(10, 'rate limited');
    if (job.payload.raise === 'permanent') throw new Permanent('bad payload');
    // NOTE: one job at a time, so the jobs before this one are already reported
    const rows = [];
    for (const id of errors) rows.push(await row(id));
    resolve(rows);
  });
  const [error, retryAfter, permanent] = await snapshot;

  expect(error).toMatchObject({ state: 'queued', attempts: 1, last_error: 'boom' });
  expect(error?.seconds).toBeGreaterThan(0.5);
  expect(error?.seconds).toBeLessThanOrEqual(1);
  expect(retryAfter).toMatchObject({ state: 'queued', attempts: 1, last_error: 'rate limited' });
  expect(retryAfter?.seconds).toBeGreaterThan(9.5);
  expect(retryAfter?.seconds).toBeLessThanOrEqual(10);
  expect(permanent).toMatchObject({ state: 'dead', attempts: 1, last_error: 'bad payload' });
});

test('heartbeats a job longer than its lease, so it starts once', { timeout: 15_000 }, async () => {
  const queue = await newQueue('heartbeat');
  const lease = 1;
  let starts = 0;
  const handle = async () => {
    starts++;
    await sleep(3 * lease * 1000);
  };
  await startWorker(queue, handle, lease);
  await startWorker(queue, handle, lease);
  const id = await enqueue(db, queue, {});
  await vi.waitFor(async () => expect(await row(id)).toBeUndefined(), {
    timeout: 10 * lease * 1000,
    interval: 20
  });
  expect(starts).toBe(1);
});

test("wakes an idle worker on its queue's channel", async () => {
  const queue = await newQueue('wake');
  let started = Promise.withResolvers<number>();
  await startWorker(queue, () => Promise.resolve(started.resolve(performance.now())));
  // NOTE: the first job proves the worker runs; after it the worker idles, waiting up to the 30 s lease
  await enqueue(db, queue, {});
  await started.promise;
  started = Promise.withResolvers<number>();
  await sleep(200);

  const enqueued = performance.now();
  await enqueue(db, queue, {});
  const at = await Promise.race([started.promise, sleep(1000).then(() => Infinity)]);
  expect(at - enqueued).toBeLessThan(1000);
});

test("skips the runner's report after complete in the handler's transaction", async () => {
  const queue = await newQueue('complete');
  const app = await connect();
  const warn = vi.spyOn(console, 'warn');
  const done = Promise.withResolvers<void>();
  await startWorker(
    queue,
    async (job) => {
      if (job.payload.last) return done.resolve();
      await app.query('BEGIN');
      await enqueue(
        app,
        `${queue}-followup`,
        { parent: job.id },
        { groupKey: job.group_key ?? undefined }
      );
      const completed = await complete(app, job);
      // NOTE: lets a heartbeat tick land between complete and COMMIT
      await sleep(200);
      await app.query(completed ? 'COMMIT' : 'ROLLBACK');
    },
    0.3
  );

  const id = await enqueue(db, queue, {}, { groupKey: 'group' });
  // NOTE: one job at a time, so once this one runs the first is reported
  await enqueue(db, queue, { last: true });
  await done.promise;
  expect(warn).not.toHaveBeenCalled();
  expect(await row(id)).toBeUndefined();
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*) FROM queue_jobs WHERE queue = $1 AND group_key = 'group' AND (payload->>'parent')::bigint = $2",
    [`${queue}-followup`, id]
  );
  expect(rows[0].count).toBe('1');
});

test('keeps heartbeating after a failed extend', async () => {
  const queue = await newQueue('heartbeat-error');
  const app = await connect();
  const warn = vi.spyOn(console, 'warn').mockClear();
  const { promise: running, resolve } = Promise.withResolvers<Row | undefined>();
  await startWorker(
    queue,
    async (job) => {
      // NOTE: holds the job's row lock past the worker's lock_timeout, so its first heartbeat fails
      await app.query('BEGIN');
      await app.query('SELECT FROM queue_jobs WHERE id = $1 FOR UPDATE', [job.id]);
      await sleep(450);
      await app.query('COMMIT');
      // NOTE: past the first lease, so only a later heartbeat keeps the job
      await sleep(1000);
      resolve(await row(job.id));
    },
    0.9,
    { lock_timeout: 100 }
  );
  await enqueue(db, queue, {});
  const job = await running;
  expect(warn).toHaveBeenCalled();
  for (const [message] of warn.mock.calls) expect(message).toMatch(/^heartbeat failed/);
  expect(job?.state).toBe('running');
  expect(job?.seconds).toBeGreaterThan(0);
});

test('rejects when its idle connection fails, instead of crashing', async () => {
  const client = await connect();
  const {
    rows: [{ pid }]
  } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const working = expect(
    work(client, await newQueue('idle-error'), 'worker', async () => {})
  ).rejects.toThrow(/terminating connection/);
  // NOTE: lets the worker go idle, waiting up to the 30 s lease
  await sleep(200);
  await db.query('SELECT pg_terminate_backend($1)', [pid]);
  await working;
});

test('rejects a lease that is not positive', async () => {
  await expect(work(new pg.Client(), 'ts-lease', 'worker', async () => {}, 0)).rejects.toThrow(
    /lease/
  );
});
