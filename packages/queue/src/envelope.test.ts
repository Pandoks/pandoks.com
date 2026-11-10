import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MAX_DELAY, MAX_ENVELOPE_BYTES, decode, encode, type Message } from './envelope.ts';
import { openQueue, openTopic } from './index.ts';

const fixtures = new URL('../testdata/envelopes/', import.meta.url);
const fixtureBodies = readdirSync(fixtures).map((name) => ({
  name,
  body: readFileSync(new URL(name, fixtures), 'utf8')
}));

describe('envelope', () => {
  test.each(fixtureBodies)('$name round-trips', ({ body }) => {
    const delivery = decode(body, { attempt: 1, deadline: new Date(), handle: undefined });
    expect(JSON.parse(encode(delivery, delivery.time))).toEqual(JSON.parse(body));
  });

  test('encode rejects what other brokers cannot carry', () => {
    const valid: Message = { source: '//test', type: 'test' };
    const invalid: Message[] = [
      { ...valid, extensions: { 'Notification-ID': '1' } },
      { ...valid, extensions: { source: 'x' } },
      { ...valid, delay: MAX_DELAY + 1 },
      { ...valid, data: new TextEncoder().encode(JSON.stringify('x'.repeat(MAX_ENVELOPE_BYTES))) },
      { ...valid, data: new TextEncoder().encode('{') }
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
    expect(() => decode(body, { attempt: 1, deadline: new Date(), handle: undefined })).toThrow();
  });

  test.each([
    '2026-11-09T18:00:00',
    '2026-11-09',
    '2026-11-09 18:00:00Z',
    '2026-11-09T24:00:00Z',
    '2026-02-30T18:00:00Z'
  ])('decode rejects the time %s like Go does', (time) => {
    const body = JSON.stringify({
      specversion: '1.0',
      id: 'x',
      source: '//test',
      type: 'test',
      time
    });
    expect(() => decode(body, { attempt: 1, deadline: new Date(), handle: undefined })).toThrow();
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
    expect(() => decode(body, { attempt: 1, deadline: new Date(), handle: undefined })).toThrow();
  });

  test.each(['xq1/zq2', 'xq1?zq2', 'xq1#zq2', '123/zq2', '123?zq2', '123#zq2'])(
    'open keeps the valkey password %s out of errors',
    async (password) => {
      const url = `valkey://client:${password}@127.0.0.1:1/q?lease=1s&max_attempts=1`;
      for (const open of [openQueue, openTopic]) {
        const error: unknown = await open(url).then(
          () => undefined,
          (thrown: unknown) => thrown
        );
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(error) + String(error)).not.toMatch(/xq1|zq2/);
      }
    }
  );
});
