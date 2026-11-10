import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MAX_DELAY, MAX_ENVELOPE_BYTES, decode, encode, type Message } from './envelope.ts';

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
});
