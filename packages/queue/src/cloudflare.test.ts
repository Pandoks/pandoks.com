import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';
import { encode } from './envelope.ts';
import { openQueue, openTopic } from './index.ts';

// Checks what the adapter sends Cloudflare's API, which has no emulator; the CI job's live
// queues prove how Cloudflare answers.
test('cloudflare requests', async () => {
  const requests: Record<string, Record<string, unknown>[]> = {};
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown[]>;
      const path = request.url!;
      (requests[path] ??= []).push(body);
      const pushed = requests['/accounts/acct/queues/q1/messages/batch'];
      let result: Record<string, unknown> = {};
      if (path.endsWith('/pull') && pushed) {
        const [first] = pushed[0].messages as { body: string }[];
        result = { messages: [{ id: 'm1', body: first.body, lease_id: 'lease-1', attempts: 1 }] };
      } else if (path.endsWith('/ack')) {
        result = { ackCount: body.acks.length, retryCount: body.retries.length };
        if (body.retries.length > 0) {
          result.warnings = { m1: 'Message has exhausted maxRetries' };
        }
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, errors: [], messages: [], result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('CLOUDFLARE_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  try {
    const queue = await openQueue('cloudflare://acct/q1?lease=90s');
    const started = Date.now();
    expect(await queue.receive(500)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);

    const messages = Array.from({ length: 150 }, (_, index) => ({
      id: `m${index}`,
      source: '//test',
      type: 'test',
      data: new TextEncoder().encode('{}'),
      delay: index === 0 ? 1.5 : 0
    }));
    await queue.send(...messages);
    const deliveries = await queue.receive(500);
    expect(deliveries.map((delivery) => [delivery.id, delivery.attempt])).toEqual([['m0', 2]]);
    await queue.retry(3, ...deliveries);
    await queue.ack(...deliveries);
    await (await openTopic('cloudflare://acct/q1,q2')).publish({ source: '//test', type: 'test' });
  } finally {
    vi.unstubAllEnvs();
    server.close();
  }

  const batches = requests['/accounts/acct/queues/q1/messages/batch'];
  expect(batches.map((batch) => (batch.messages as unknown[]).length)).toEqual([100, 50, 1]);
  expect((batches[0].messages as Record<string, unknown>[])[0]).toMatchObject({
    content_type: 'text',
    delay_seconds: 2
  });
  expect((batches[0].messages as Record<string, unknown>[])[1]).not.toHaveProperty('delay_seconds');
  expect(requests['/accounts/acct/queues/q2/messages/batch']).toHaveLength(1);
  expect(requests['/accounts/acct/queues/q1/messages/pull'][0]).toEqual({
    batch_size: 100,
    visibility_timeout_ms: 90_000
  });
  const [retry, ack] = requests['/accounts/acct/queues/q1/messages/ack'];
  expect(retry.retries).toEqual([{ lease_id: 'lease-1', delay_seconds: 3 }]);
  expect(ack.acks).toEqual([{ lease_id: 'lease-1' }]);
});

test('cloudflare lease starts after a slow pull', async () => {
  const body = encode({ id: 'slow', source: '//test', type: 'test' }, new Date());
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      setTimeout(() => {
        const pulled = [{ id: 'm1', body, lease_id: 'lease-1', attempts: 0 }];
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({ success: true, errors: [], messages: [], result: { messages: pulled } })
        );
      }, 2000);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('CLOUDFLARE_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  try {
    const deliveries = await (await openQueue('cloudflare://acct/q1?lease=1s')).receive(10);
    expect(deliveries.map((delivery) => delivery.id)).toEqual(['slow']);
    expect(deliveries[0].deadline.getTime()).toBeGreaterThan(Date.now());
  } finally {
    vi.unstubAllEnvs();
    server.close();
  }
});
