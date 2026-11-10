// Cloudflare queues with an HTTP pull consumer; CLOUDFLARE_API_TOKEN needs Queues Edit.
import Cloudflare from 'cloudflare';
import {
  batches,
  checkDelay,
  decodeRows,
  delaySeconds,
  encode,
  parseLease,
  queryParams,
  sleep,
  type Delivery,
  type Message,
  type Queue,
  type Topic
} from './envelope.ts';

const BATCH_COUNT = 100;
const BATCH_BYTES = 256_000;
const METADATA_BYTES = 100;
const EMPTY_POLL_DELAY = 1;
// the ack warning for a retried message that moves to the dead-letter queue
const DEAD_LETTERED = 'Message has exhausted maxRetries';

interface Entry {
  body: string;
  content_type: 'text';
  delay_seconds?: number;
}

function cloudflareQueues(
  url: URL,
  ...allowed: string[]
): { queues: CloudflareQueue[]; params: Record<string, string> } {
  const ids = url.pathname.replace(/^\//, '').split(',');
  // NOTE: a port is a user and the start of a password cut off by an unescaped /, ?, or #
  if (!url.host || url.port || url.username || url.password || ids.includes('')) {
    throw new Error('cloudflare URL must be cloudflare://<account_id>/<queue_id>[,<queue_id>…]');
  }
  const params = queryParams(url, ...allowed);
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error('cloudflare URL: CLOUDFLARE_API_TOKEN is not set');
  }
  const client = new Cloudflare();
  return { queues: ids.map((id) => new CloudflareQueue(client, url.host, id)), params };
}

export function openQueue(url: URL): CloudflareQueue {
  const { queues, params } = cloudflareQueues(url, 'lease');
  if (queues.length !== 1) {
    throw new Error('cloudflare URL: a queue has one queue id; a list is a topic');
  }
  queues[0].lease = parseLease(url, params);
  if (queues[0].lease < 1) {
    throw new Error(`cloudflare URL: lease ${params.lease} must be at least 1s`);
  }
  return queues[0];
}

export function openTopic(url: URL): CloudflareTopic {
  return new CloudflareTopic(cloudflareQueues(url).queues);
}

function entries(messages: Message[]): Entry[] {
  const sentAt = new Date();
  // NOTE: an explicit 0 overrides the queue's default delivery delay
  return messages.map((message) => ({
    body: encode(message, sentAt),
    content_type: 'text',
    ...(message.delay ? { delay_seconds: delaySeconds(message.delay) } : {})
  }));
}

export class CloudflareQueue implements Queue {
  client: Cloudflare;
  account: string;
  id: string;
  lease = 0;

  constructor(client: Cloudflare, account: string, id: string) {
    this.client = client;
    this.account = account;
    this.id = id;
  }

  async push(pushed: Entry[]): Promise<void> {
    const size = (entry: Entry) => Buffer.byteLength(entry.body) + METADATA_BYTES;
    for (const batch of batches(pushed, size, BATCH_COUNT, BATCH_BYTES)) {
      await this.client.queues.messages.bulkPush(this.id, {
        account_id: this.account,
        messages: batch
      });
    }
  }

  async send(...messages: Message[]): Promise<void> {
    await this.push(entries(messages));
  }

  async receive(max: number, signal?: AbortSignal): Promise<Delivery[]> {
    if (max < 1) throw new Error(`receive from Cloudflare: max ${max} must be at least 1`);
    let response;
    try {
      response = await this.client.queues.messages.pull(
        this.id,
        {
          account_id: this.account,
          batch_size: Math.min(max, BATCH_COUNT),
          visibility_timeout_ms: Math.round(this.lease * 1000)
        },
        { signal }
      );
    } catch (error) {
      if (signal?.aborted) return [];
      throw error;
    }
    // NOTE: the lease starts when Cloudflare answers, which can be well after the call on a slow network
    const deadline = new Date(Date.now() + this.lease * 1000);
    const pulled = response.messages ?? [];
    const { deliveries, malformed } = decodeRows(
      pulled.map((message): [string, number, unknown] => [
        message.body!,
        message.attempts! + 1,
        message.lease_id
      ]),
      deadline
    );
    await this.settle(
      malformed.map((handle) => ({ lease_id: handle as string })),
      []
    );
    // NOTE: pulls don't long-poll and every empty one is a billed read
    if (pulled.length === 0) await sleep(EMPTY_POLL_DELAY, signal);
    return deliveries;
  }

  private async settle(
    acks: { lease_id: string }[],
    retries: { lease_id: string; delay_seconds: number }[]
  ): Promise<void> {
    if (acks.length === 0 && retries.length === 0) return;
    const response = await this.client.queues.messages.ack(this.id, {
      account_id: this.account,
      acks,
      retries
    });
    const warnings = Object.values(response.warnings ?? {});
    const deadLettered = warnings.filter((warning) => warning === DEAD_LETTERED).length;
    if (
      response.ackCount !== acks.length ||
      response.retryCount !== retries.length ||
      deadLettered !== warnings.length ||
      deadLettered > retries.length
    ) {
      throw new Error(`settle Cloudflare queue ${this.id} messages: ${JSON.stringify(response)}`);
    }
  }

  async ack(...deliveries: Delivery[]): Promise<void> {
    for (const batch of batches(deliveries, () => 0, BATCH_COUNT, Infinity)) {
      await this.settle(
        batch.map((delivery) => ({ lease_id: delivery.handle as string })),
        []
      );
    }
  }

  async retry(delay: number, ...deliveries: Delivery[]): Promise<void> {
    checkDelay(delay);
    for (const batch of batches(deliveries, () => 0, BATCH_COUNT, Infinity)) {
      await this.settle(
        [],
        batch.map((delivery) => ({
          lease_id: delivery.handle as string,
          delay_seconds: delaySeconds(delay)
        }))
      );
    }
  }

  async close(): Promise<void> {}
}

/**
 * Sends each message to every listed queue. It isn't atomic: a failed publish is retried
 * whole, so subscribers dedupe on the envelope id.
 */
export class CloudflareTopic implements Topic {
  subscriptions: CloudflareQueue[];

  constructor(subscriptions: CloudflareQueue[]) {
    this.subscriptions = subscriptions;
  }

  async publish(...messages: Message[]): Promise<void> {
    if (messages.some((message) => message.delay)) {
      throw new Error('publish to Cloudflare: topics take no delay');
    }
    const published = entries(messages);
    for (const subscription of this.subscriptions) {
      await subscription.push(published);
    }
  }

  async close(): Promise<void> {}
}
