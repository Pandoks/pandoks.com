// Queue and pub/sub over SQS and SNS, Cloudflare Queues, or Valkey, chosen by URL. See README.md
// for the spec the Go, Python, and TypeScript packages share.
import type { Queue, Topic } from './envelope.ts';

export {
  MAX_DELAY,
  MAX_ENVELOPE_BYTES,
  type Delivery,
  type Message,
  type Queue,
  type Topic
} from './envelope.ts';
export { Permanent, RetryAfter, Worker } from './worker.ts';

/** Parses a URL, rejecting a path URL.parse would rewrite: it drops dot segments, so a/../b opens b. */
function parse(url: string, action: string): URL {
  const rawPath = /^[^:]*:(?:\/\/[^/?#]*)?([^?#]*)/.exec(url)?.[1] ?? '';
  // NOTE: not new URL, whose error carries the whole URL, password included
  const parsed = URL.parse(url);
  if (!parsed) throw new Error(`${action}: URL does not parse`);
  if (
    rawPath
      .split('/')
      .slice(1)
      .some((segment) => /^(?:\.|%2e){0,2}$/i.test(segment))
  ) {
    throw new Error(`${action}: URL path has an empty or dot segment`);
  }
  return parsed;
}

/** Opens a queue, or a topic's subscription, from its URL. */
export async function openQueue(url: string): Promise<Queue> {
  const parsed = parse(url, 'open queue');
  switch (parsed.protocol) {
    case 'awssqs:':
      return (await import('./sqs.ts')).openQueue(parsed);
    case 'cloudflare:':
      return (await import('./cloudflare.ts')).openQueue(parsed);
    case 'valkey:':
      return (await import('./valkey.ts')).openQueue(parsed);
  }
  throw new Error(`open queue: unknown scheme ${parsed.protocol}`);
}

/** Opens a topic from its URL. */
export async function openTopic(url: string): Promise<Topic> {
  const parsed = parse(url, 'open topic');
  switch (parsed.protocol) {
    case 'awssns:':
      return (await import('./sns.ts')).openTopic(parsed);
    case 'cloudflare:':
      return (await import('./cloudflare.ts')).openTopic(parsed);
    case 'valkey:':
      return (await import('./valkey.ts')).openTopic(parsed);
  }
  throw new Error(`open topic: unknown scheme ${parsed.protocol}`);
}
