import { expect, test, vi } from 'vitest';
import { MAX_DELAY, type Delivery, type Queue } from './envelope.ts';
import { Permanent, RetryAfter, Worker } from './worker.ts';

test('the worker settles each outcome', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const controller = new AbortController();
  const deadline = new Date(Date.now() + 60_000);
  let deliveries: Delivery[] = ['ok', 'permanent', 'retry-after', 'failed', 'shutdown'].map(
    (id) => ({
      id,
      source: '//test',
      type: 'test',
      contentType: 'application/json',
      extensions: {},
      time: deadline,
      attempt: 3,
      deadline,
      handle: id
    })
  );
  const maxes: number[] = [];
  const acked: string[] = [];
  const retried: Record<string, number> = {};
  const queue: Queue = {
    send: async () => {},
    receive: async (max, signal) => {
      maxes.push(max);
      const received = deliveries.slice(0, max);
      deliveries = deliveries.slice(max);
      if (received.length === 0) {
        await new Promise((resolve) => signal?.addEventListener('abort', resolve));
      }
      return received;
    },
    ack: (...settled) => {
      acked.push(...settled.map((delivery) => delivery.id));
      return Promise.resolve();
    },
    retry: (delay, ...settled) => {
      for (const delivery of settled) retried[delivery.id] = delay;
      return Promise.resolve();
    },
    close: async () => {}
  };
  let abortedWhileHandling: boolean | undefined;
  const worker = new Worker({
    queue,
    concurrency: 2,
    handle: async (delivery, signal) => {
      await Promise.resolve();
      switch (delivery.id) {
        case 'ok':
          abortedWhileHandling = signal.aborted;
          return;
        case 'permanent':
          throw new Permanent('malformed');
        case 'retry-after':
          throw new RetryAfter(3600, 'rate limited');
        case 'failed':
          throw new Error('transient');
      }
      controller.abort();
      expect(signal.aborted).toBe(true);
      throw new Error('stopped');
    }
  });
  await worker.run(controller.signal);

  expect(abortedWhileHandling).toBe(false);
  expect(acked.sort()).toEqual(['ok', 'permanent']);
  expect(retried).toEqual({ 'retry-after': MAX_DELAY, failed: 4, shutdown: 4 });
  expect(maxes.every((max) => max >= 1 && max <= 2)).toBe(true);
});

test('the worker releases what it receives after shutdown', async () => {
  const controller = new AbortController();
  const deadline = new Date(Date.now() + 60_000);
  const late: Delivery = {
    id: 'late',
    source: '//test',
    type: 'test',
    contentType: 'application/json',
    extensions: {},
    time: deadline,
    attempt: 1,
    deadline,
    handle: 'late'
  };
  const settled: string[] = [];
  const queue: Queue = {
    send: async () => {},
    receive: () => {
      controller.abort();
      return Promise.resolve([late]);
    },
    ack: (...acked) => {
      settled.push(...acked.map((delivery) => `ack ${delivery.id}`));
      return Promise.resolve();
    },
    retry: (delay, ...retried) => {
      settled.push(...retried.map((delivery) => `retry ${delivery.id} after ${delay}`));
      return Promise.resolve();
    },
    close: async () => {}
  };
  const handled: string[] = [];
  await new Worker({
    queue,
    concurrency: 1,
    handle: (delivery) => {
      handled.push(delivery.id);
      return Promise.resolve();
    }
  }).run(controller.signal);

  expect(handled).toEqual([]);
  expect(settled).toEqual(['retry late after 0']);
});
