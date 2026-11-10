// Valkey cluster queues and topics built from the shared Lua scripts in packages/queue/valkey.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClusterBatch, GlideClusterClient, Script } from '@valkey/valkey-glide';
import {
  checkDelay,
  decodeRows,
  encode,
  parseLease,
  queryParams,
  sleep,
  type Delivery,
  type Message,
  type Queue,
  type Topic
} from './envelope.ts';

const GROUP = 'workers';
const EMPTY_POLL_DELAY = 0.1;

function script(name: string): Script {
  return new Script(readFileSync(new URL(`../valkey/${name}.lua`, import.meta.url), 'utf8'));
}

/** Connects to the cluster in a valkey://[user:password@]host:port/<name> URL. */
async function valkeyClient(url: URL): Promise<{ client: GlideClusterClient; name: string }> {
  const name = url.pathname.replace(/^\//, '');
  if (!url.hostname || !name || /[{}/]/.test(name)) {
    throw new Error('valkey URL must be valkey://[user:password@]host:port/<name>');
  }
  const client = await GlideClusterClient.createClient({
    addresses: [{ host: url.hostname, port: Number(url.port || 6379) }],
    credentials: url.password
      ? {
          username: decodeURIComponent(url.username) || undefined,
          password: decodeURIComponent(url.password)
        }
      : undefined
  });
  return { client, name };
}

export async function openQueue(url: URL): Promise<ValkeyQueue> {
  const params = queryParams(url, 'lease', 'max_attempts', 'subscription');
  const lease = parseLease(params);
  const maxAttempts = Number(params.max_attempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`valkey URL: max_attempts ${params.max_attempts} must be at least 1`);
  }
  const { client, name } = await valkeyClient(url);
  let prefix = `{${name}}`;
  if (params.subscription) {
    prefix += `:${params.subscription}`;
    await client.sadd(`{${name}}:subscriptions`, [params.subscription]);
  }
  return new ValkeyQueue(client, prefix, lease, maxAttempts);
}

export async function openTopic(url: URL): Promise<ValkeyTopic> {
  queryParams(url);
  const { client, name } = await valkeyClient(url);
  return new ValkeyTopic(client, name);
}

/** Keeps a queue's stream, delayed retries, and dead letters under one hash tag. */
export class ValkeyQueue implements Queue {
  client: GlideClusterClient;
  keys: string[];
  consumer = randomBytes(8).toString('hex');
  lease: number;
  maxAttempts: number;
  receiveScript = script('receive');
  retryScript = script('retry');

  constructor(client: GlideClusterClient, prefix: string, lease: number, maxAttempts: number) {
    this.client = client;
    this.keys = [`${prefix}:stream`, `${prefix}:delayed`, `${prefix}:dlq`];
    this.lease = lease;
    this.maxAttempts = maxAttempts;
  }

  async send(...messages: Message[]): Promise<void> {
    const sentAt = new Date();
    const batch = new ClusterBatch(false);
    for (const message of messages) {
      const body = encode(message, sentAt);
      if (message.delay) {
        const due = sentAt.getTime() + Math.round(message.delay * 1000);
        batch.zadd(this.keys[1], [
          { element: JSON.stringify({ envelope: body, attempt: 0 }), score: due }
        ]);
      } else {
        batch.xadd(this.keys[0], [
          ['envelope', body],
          ['attempt', '0']
        ]);
      }
    }
    await this.client.exec(batch, true);
  }

  async receive(max: number, signal?: AbortSignal): Promise<Delivery[]> {
    if (max < 1) throw new Error(`receive from Valkey: max ${max} must be at least 1`);
    const deadline = new Date(Date.now() + this.lease * 1000);
    const rows = (await this.client.invokeScript(this.receiveScript, {
      keys: this.keys,
      args: [
        GROUP,
        this.consumer,
        String(max),
        String(Math.round(this.lease * 1000)),
        String(this.maxAttempts)
      ]
    })) as [string, string, number][];
    const { deliveries, malformed } = decodeRows(
      rows.map(([streamID, body, attempt]): [string, number, unknown] => [body, attempt, streamID]),
      deadline
    );
    await this.delete(malformed as string[]);
    if (rows.length === 0) await sleep(EMPTY_POLL_DELAY, signal);
    return deliveries;
  }

  private async delete(streamIDs: string[]): Promise<void> {
    if (streamIDs.length === 0) return;
    const batch = new ClusterBatch(false)
      .xack(this.keys[0], GROUP, streamIDs)
      .xdel(this.keys[0], streamIDs);
    await this.client.exec(batch, true);
  }

  async ack(...deliveries: Delivery[]): Promise<void> {
    await this.delete(deliveries.map((delivery) => delivery.handle as string));
  }

  async retry(delay: number, ...deliveries: Delivery[]): Promise<void> {
    checkDelay(delay);
    if (deliveries.length === 0) return;
    const args = [GROUP, String(Math.round(delay * 1000)), String(this.maxAttempts)];
    for (const delivery of deliveries) {
      args.push(delivery.handle as string, String(delivery.attempt));
    }
    await this.client.invokeScript(this.retryScript, { keys: this.keys, args });
  }

  close(): Promise<void> {
    this.receiveScript.release();
    this.retryScript.release();
    this.client.close();
    return Promise.resolve();
  }
}

/** Fans each message out to every subscription registered in {<topic>}:subscriptions. */
export class ValkeyTopic implements Topic {
  client: GlideClusterClient;
  name: string;
  publishScript = script('publish');

  constructor(client: GlideClusterClient, name: string) {
    this.client = client;
    this.name = name;
  }

  async publish(...messages: Message[]): Promise<void> {
    if (messages.some((message) => message.delay)) {
      throw new Error('publish to Valkey: topics take no delay');
    }
    const sentAt = new Date();
    for (const message of messages) {
      await this.publishBody(encode(message, sentAt));
    }
  }

  /** Rereads the subscriptions when publish.lua reports they changed since the last read. */
  private async publishBody(body: string): Promise<void> {
    const subscriptionsKey = `{${this.name}}:subscriptions`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const subscriptions = [...(await this.client.smembers(subscriptionsKey))].map(String).sort();
      const keys = [
        subscriptionsKey,
        ...subscriptions.map((subscription) => `{${this.name}}:${subscription}:stream`)
      ];
      try {
        await this.client.invokeScript(this.publishScript, { keys, args: [body] });
        return;
      } catch (error) {
        if (!String(error).includes('STALE')) throw error;
      }
    }
    throw new Error(`publish to Valkey topic ${this.name}: subscriptions kept changing`);
  }

  close(): Promise<void> {
    this.publishScript.release();
    this.client.close();
    return Promise.resolve();
  }
}
