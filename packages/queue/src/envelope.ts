// The message types, the CloudEvents envelope, and the URL rules every adapter shares.
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

/** SQS's DelaySeconds maximum in seconds, the portable ceiling for every delay. */
export const MAX_DELAY = 900;
/** Fits Cloudflare's 128 KB message limit with room for its metadata. */
export const MAX_ENVELOPE_BYTES = 120_000;

const EXTENSION_NAME = /^[a-z0-9]{1,20}$/;
const ATTRIBUTES = new Set([
  'specversion',
  'id',
  'source',
  'type',
  'time',
  'datacontenttype',
  'data',
  'data_base64'
]);
const DURATION = /^(\d+)(ms|s|m|h)$/;
const DURATION_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
const RFC3339 =
  /^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):\d\d:\d\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * What a producer sends. JSON data goes in the envelope's data member, anything else in
 * data_base64. A missing id becomes a random one, and delay is in seconds.
 */
export interface Message {
  source: string;
  type: string;
  data?: Uint8Array;
  id?: string;
  contentType?: string;
  extensions?: Record<string, string>;
  delay?: number;
}

/**
 * A received message. attempt is 1 on the first delivery, and the broker redelivers it once
 * deadline passes unless it is acked or retried first.
 */
export interface Delivery extends Message {
  id: string;
  contentType: string;
  extensions: Record<string, string>;
  time: Date;
  attempt: number;
  deadline: Date;
  handle: unknown;
}

export interface Queue {
  send(...messages: Message[]): Promise<void>;
  /** Resolves early with nothing once signal aborts. */
  receive(max: number, signal?: AbortSignal): Promise<Delivery[]>;
  ack(...deliveries: Delivery[]): Promise<void>;
  retry(delay: number, ...deliveries: Delivery[]): Promise<void>;
  close(): Promise<void>;
}

export interface Topic {
  publish(...messages: Message[]): Promise<void>;
  close(): Promise<void>;
}

export function isJSON(contentType: string): boolean {
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/** Writes message as a CloudEvents 1.0 structured JSON envelope sent at sentAt. */
export function encode(message: Message, sentAt: Date): string {
  if (!message.source || !message.type) {
    throw new Error('encode message: source and type are required');
  }
  checkDelay(message.delay ?? 0);
  for (const name of Object.keys(message.extensions ?? {})) {
    if (!EXTENSION_NAME.test(name) || ATTRIBUTES.has(name)) {
      throw new Error(
        `encode message: extension name ${name} must be [a-z0-9]{1,20} and not an attribute`
      );
    }
  }
  const event: Record<string, unknown> = {
    ...message.extensions,
    specversion: '1.0',
    id: message.id || randomUUID(),
    source: message.source,
    type: message.type,
    time: sentAt.toISOString(),
    datacontenttype: message.contentType || 'application/json'
  };
  if (message.data && isJSON(event.datacontenttype as string)) {
    event.data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data));
  } else if (message.data) {
    event.data_base64 = Buffer.from(message.data).toString('base64');
  }
  const body = JSON.stringify(event);
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_ENVELOPE_BYTES) {
    throw new Error(
      `encode message ${String(event.id)}: envelope is ${bytes} bytes, over ${MAX_ENVELOPE_BYTES}`
    );
  }
  return body;
}

/** Reads an envelope into a Delivery with the broker's attempt, deadline, and handle. */
export function decode(
  body: string,
  delivery: { attempt: number; deadline: Date; handle: unknown }
): Delivery {
  const event: unknown = JSON.parse(body);
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new Error('decode envelope: not an object');
  }
  const members: Record<string, string> = {};
  for (const [name, value] of Object.entries(event)) {
    if (name === 'data' || name === 'data_base64') continue;
    if (typeof value !== 'string') {
      throw new Error(`decode envelope: ${name} is not a string`);
    }
    members[name] = value;
  }
  if (members.specversion !== '1.0' || !members.id || !members.source || !members.type) {
    throw new Error('decode envelope: specversion 1.0, id, source, and type are required');
  }
  const time = new Date(members.time);
  // NOTE: Date rolls a day past the month's end, like Feb 30, over into the next month, and takes
  // year 0000, which Python rejects
  const day = members.time.slice(0, 10);
  if (
    !RFC3339.test(members.time) ||
    Number.isNaN(time.getTime()) ||
    new Date(day).toISOString().slice(0, 10) !== day ||
    day.startsWith('0000')
  ) {
    throw new Error(`decode envelope ${members.id}: time ${members.time} is not RFC 3339`);
  }
  if ('data' in event && 'data_base64' in event) {
    throw new Error(`decode envelope ${members.id}: data and data_base64 are mutually exclusive`);
  }
  let data: Uint8Array | undefined;
  if ('data_base64' in event) {
    if (typeof event.data_base64 !== 'string') {
      throw new Error(`decode envelope ${members.id}: data_base64 is not a string`);
    }
    data = new Uint8Array(Buffer.from(event.data_base64, 'base64'));
    // NOTE: Buffer skips invalid characters, so only canonical base64 round-trips
    if (Buffer.from(data).toString('base64') !== event.data_base64) {
      throw new Error(`decode envelope ${members.id}: data_base64 is not valid base64`);
    }
  } else if ('data' in event) {
    data = new TextEncoder().encode(JSON.stringify(event.data));
  }
  const extensions = Object.fromEntries(
    Object.entries(members).filter(([name]) => !ATTRIBUTES.has(name))
  );
  return {
    id: members.id,
    source: members.source,
    type: members.type,
    contentType: members.datacontenttype ?? 'application/json',
    extensions,
    data,
    time,
    ...delivery
  };
}

/**
 * Decodes [body, attempt, handle] rows, returning the deliveries and the handles of malformed
 * messages, which adapters ack and log instead of retrying.
 */
export function decodeRows(
  rows: [string, number, unknown][],
  deadline: Date
): { deliveries: Delivery[]; malformed: unknown[] } {
  const deliveries: Delivery[] = [];
  const malformed: unknown[] = [];
  for (const [body, attempt, handle] of rows) {
    try {
      deliveries.push(decode(body, { attempt, deadline, handle }));
    } catch (error) {
      console.error('queue dropped a malformed message', error);
      malformed.push(handle);
    }
  }
  return { deliveries, malformed };
}

/** Throws when an AWS batch call reports failed entries. */
export function checkFailed(action: string, failed: { Message?: string }[] | undefined): void {
  if (failed?.length) {
    throw new Error(`${action}: ${failed.length} failed: ${failed[0].Message}`);
  }
}

/** Returns the URL's query, rejecting parameters outside allowed and repeated ones. */
export function queryParams(url: URL, ...allowed: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) {
      throw new Error(`${url.protocol} URL: unexpected parameter ${name}`);
    }
    params[name] = url.searchParams.get(name)!;
  }
  return params;
}

/** Reads the required lease parameter in seconds, written like 500ms, 30s, 2m, or 1h. */
export function parseLease(params: Record<string, string>): number {
  const match = DURATION.exec(params.lease ?? '');
  if (!match) {
    throw new Error(`lease ${params.lease} must be a whole number of ms, s, m, or h`);
  }
  const lease = Number(match[1]) * DURATION_SECONDS[match[2]];
  if (lease <= 0 || lease > 12 * 3600) {
    throw new Error(`lease ${params.lease} must be more than 0 and at most 12h`);
  }
  return lease;
}

export function checkDelay(delay: number): void {
  if (!(delay >= 0 && delay <= MAX_DELAY)) {
    throw new Error(`delay ${delay}s must be between 0 and ${MAX_DELAY}s`);
  }
}

/** Rounds a checked delay up to whole seconds. */
export function delaySeconds(delay: number): number {
  return Math.ceil(delay);
}

/** The worker's retry delay after a failed attempt: 1 s, 2 s, 4 s, … up to MAX_DELAY. */
export function backoff(attempt: number): number {
  return Math.min(2 ** Math.min(Math.max(attempt - 1, 0), 10), MAX_DELAY);
}

/** Splits items into runs of at most maxCount items and maxBytes total size. */
export function batches<T>(
  items: T[],
  size: (item: T) => number,
  maxCount: number,
  maxBytes: number
): T[][] {
  const result: T[][] = [];
  let bytes = 0;
  for (const item of items) {
    const last = result.at(-1);
    if (!last || last.length === maxCount || bytes + size(item) > maxBytes) {
      result.push([item]);
      bytes = size(item);
    } else {
      last.push(item);
      bytes += size(item);
    }
  }
  return result;
}

/** Sleeps for seconds, ending early once signal aborts. */
export async function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  await setTimeout(seconds * 1000, undefined, { signal }).catch((error: unknown) => {
    if (!signal?.aborted) throw error;
  });
}
