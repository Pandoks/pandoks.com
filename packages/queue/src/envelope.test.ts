import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  MAX_DELAY,
  MAX_ENVELOPE_BYTES,
  decodeRows,
  delayMilliseconds,
  encode,
  type Message
} from './envelope.ts';
import { openQueue, openTopic } from './index.ts';

function readFixtures(directory: string): { name: string; body: string }[] {
  const url = new URL(`../testdata/${directory}/`, import.meta.url);
  return readdirSync(url).map((name) => ({ name, body: readFileSync(new URL(name, url), 'utf8') }));
}

function decode(body: string) {
  return decodeRows([[body, 1, undefined]], new Date());
}

describe('envelope', () => {
  test.each(readFixtures('envelopes'))('$name round-trips', ({ body }) => {
    const [delivery] = decode(body).deliveries;
    const encoded = encode(delivery, delivery.time);
    expect(JSON.parse(encoded)).toEqual(JSON.parse(body));
    // NOTE: SQS rejects them raw
    expect(encoded).not.toMatch(/[\ufffe\uffff]/);
  });

  test('delayMilliseconds rounds up to whole milliseconds', () => {
    for (const [seconds, milliseconds] of [
      [0, 0],
      [0.0005, 1],
      [0.0019, 2],
      [0.002, 2],
      [2.007, 2007]
    ]) {
      expect(delayMilliseconds(seconds)).toBe(milliseconds);
    }
  });

  test('encode rejects what other brokers cannot carry', () => {
    const valid: Message = { source: '//test', type: 'test' };
    const invalid: Message[] = [
      { ...valid, extensions: { 'Notification-ID': '1' } },
      { ...valid, extensions: { source: 'x' } },
      { ...valid, delay: MAX_DELAY + 1 },
      { ...valid, data: new TextEncoder().encode(JSON.stringify('x'.repeat(MAX_ENVELOPE_BYTES))) },
      { ...valid, data: new TextEncoder().encode('{') },
      { ...valid, data: new TextEncoder().encode('\ufeff{}') },
      { ...valid, data: new TextEncoder().encode('1e400') },
      { ...valid, data: new TextEncoder().encode('['.repeat(64) + ']'.repeat(64)) },
      { ...valid, id: 'cut \ud83d' },
      { ...valid, contentType: 'text/plain\udc00' },
      { ...valid, extensions: { ext: '\udc00' } }
    ];
    for (const message of invalid) {
      expect(() => encode(message, new Date())).toThrow();
    }
    encode(valid, new Date());
  });

  test('decode rejects invalid base64 like Go and Python do', () => {
    const body = JSON.stringify({
      specversion: '1.0',
      id: 'x',
      source: '//test',
      type: 'test',
      time: '2026-11-09T18:00:00.000Z',
      datacontenttype: 'application/octet-stream',
      data_base64: '!!!'
    });
    expect(decode(body).malformed).toHaveLength(1);
  });

  test.each([
    '2026-11-09T18:00:00',
    '2026-11-09',
    '2026-11-09 18:00:00Z',
    '2026-11-09T24:00:00Z',
    '2026-02-30T18:00:00Z',
    '0000-01-01T00:00:00Z'
  ])('decode rejects the time %s like Go and Python do', (time) => {
    const body = JSON.stringify({
      specversion: '1.0',
      id: 'x',
      source: '//test',
      type: 'test',
      time
    });
    expect(decode(body).malformed).toHaveLength(1);
  });

  test('decode rejects both data and data_base64 like Go and Python do', () => {
    const body = JSON.stringify({
      specversion: '1.0',
      id: 'x',
      source: '//test',
      type: 'test',
      time: '2026-11-09T18:00:00.000Z',
      data: {},
      data_base64: 'e30='
    });
    expect(decode(body).malformed).toHaveLength(1);
  });

  test.each(readFixtures('malformed'))('decode drops the malformed $name', ({ body }) => {
    expect(decode(body).malformed).toHaveLength(1);
  });

  test('decode keeps an empty content type', () => {
    const body = JSON.stringify({
      specversion: '1.0',
      id: 'x',
      source: '//test',
      type: 'test',
      time: '2026-11-09T18:00:00.000Z',
      datacontenttype: ''
    });
    expect(decode(body).deliveries[0].contentType).toBe('');
  });

  test('open rejects a valkey URL without a port', async () => {
    for (const open of [openQueue, openTopic]) {
      await expect(open('valkey://127.0.0.1/q?lease=1s&max_attempts=1')).rejects.toThrow(
        'host:port'
      );
    }
  });

  const malformedURLs = JSON.parse(
    readFileSync(new URL('../testdata/malformed-urls.json', import.meta.url), 'utf8')
  ) as { queues: string[]; topics: string[] };
  test.each([
    ...malformedURLs.queues.map((url) => ({ url, open: openQueue })),
    ...malformedURLs.topics.map((url) => ({ url, open: openTopic }))
  ])('open rejects $url without echoing its password', async ({ url, open }) => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
    const error: unknown = await open(url).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    vi.unstubAllEnvs();
    expect(String(error)).toMatch(/URL/);
    expect(JSON.stringify(error) + String(error)).not.toMatch(/xq1|zq2/);
  });
});
