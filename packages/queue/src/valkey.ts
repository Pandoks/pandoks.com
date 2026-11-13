// Valkey cluster queues and topics built from the shared Lua scripts in packages/queue/valkey.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Decoder, GlideClusterClient, Script } from '@valkey/valkey-glide';
import {
  checkDelay,
  decodeRows,
  delayMilliseconds,
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
// NOTE: GLIDE's 250 ms default fails a slow receive or send that Valkey still applies
const REQUEST_TIMEOUT_MS = 10_000;

function script(name: string): Script {
  return new Script(readFileSync(new URL(`../valkey/${name}.lua`, import.meta.url), 'utf8'));
}

/**
 * Reads <name> from a valkey://[user:password@]host:port/<name> URL. Check it before anything that
 * echoes the URL: an unescaped /, ?, or # in the password leaves no valid name.
 */
function valkeyName(url: URL): string {
  const [name, ...credentials] = [url.pathname.replace(/^\//, ''), url.username, url.password].map(
    (part) => {
      // NOTE: it throws on a malformed escape or one that isn't UTF-8, which Go and Python reject
      try {
        return decodeURIComponent(part);
      } catch {
        return undefined;
      }
    }
  );
  if (
    !url.hostname ||
    !url.port ||
    !name ||
    /[{}/]/.test(name) ||
    credentials.includes(undefined)
  ) {
    throw new Error('valkey URL must be valkey://[user:password@]host:port/<name>');
  }
  // NOTE: GLIDE sends no AUTH for an empty password, so a named user can't log in without one
  if (url.username && !url.password) throw new Error('valkey URL: a named user needs a password');
  return name;
}

function valkeyClient(url: URL): Promise<GlideClusterClient> {
  return GlideClusterClient.createClient({
    addresses: [{ host: url.hostname, port: Number(url.port) }],
    credentials: url.password
      ? {
          username: decodeURIComponent(url.username) || undefined,
          password: decodeURIComponent(url.password)
        }
      : undefined,
    requestTimeout: REQUEST_TIMEOUT_MS
  });
}

export async function openQueue(url: URL): Promise<ValkeyQueue> {
  const name = valkeyName(url);
  const params = queryParams(url, 'lease', 'max_attempts', 'subscription');
  const lease = parseLease(url, params);
  const maxAttempts = Number(params.max_attempts);
  if (
    !/^\d+$/.test(params.max_attempts ?? '') ||
    maxAttempts < 1 ||
    BigInt(params.max_attempts) >= 2n ** 63n
  ) {
    throw new Error(`valkey URL: max_attempts ${params.max_attempts} must be from 1 to 2^63-1`);
  }
  const client = await valkeyClient(url);
  let prefix = `{${name}}`;
  if (params.subscription !== undefined) {
    if (!params.subscription) {
      client.close();
      throw new Error('valkey URL: subscription is empty');
    }
    prefix += `:${params.subscription}`;
    try {
      await client.sadd(`{${name}}:subscriptions`, [params.subscription]);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  return new ValkeyQueue(client, prefix, lease, maxAttempts);
}

export async function openTopic(url: URL): Promise<ValkeyTopic> {
  const name = valkeyName(url);
  queryParams(url);
  return new ValkeyTopic(await valkeyClient(url), name);
}

/** Keeps a queue's stream, delayed retries, dead letters, and reclaim cursor under one hash tag. */
export class ValkeyQueue implements Queue {
  client: GlideClusterClient;
  keys: string[];
  consumer = randomBytes(8).toString('hex');
  lease: number;
  maxAttempts: number;
  sendScript = script('send');
  receiveScript = script('receive');
  retryScript = script('retry');
  closeScript = script('close');
  ackScript = script('ack');
  private releases: Promise<unknown> = Promise.resolve();

  constructor(client: GlideClusterClient, prefix: string, lease: number, maxAttempts: number) {
    this.client = client;
    this.keys = [`${prefix}:stream`, `${prefix}:delayed`, `${prefix}:dlq`, `${prefix}:reclaim`];
    this.lease = lease;
    this.maxAttempts = maxAttempts;
  }

  async send(...messages: Message[]): Promise<void> {
    const sentAt = new Date();
    const args = messages.flatMap((message) => {
      const body = encode(message, sentAt);
      return [String(delayMilliseconds(message.delay ?? 0)), body];
    });
    await this.client.invokeScript(this.sendScript, { keys: this.keys, args });
  }

  async receive(max: number, signal?: AbortSignal): Promise<Delivery[]> {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`receive from Valkey: max ${max} must be a positive integer`);
    }
    if (signal?.aborted) return [];
    // NOTE: the server starts the lease when it runs the script, after this call, so counting from
    // here never outlasts the server's lease, even when the reply is read late
    const deadline = new Date(Date.now() + this.lease * 1000);
    const invocation = this.client.invokeScript(this.receiveScript, {
      keys: this.keys,
      args: [
        GROUP,
        this.consumer,
        String(max),
        String(Math.round(this.lease * 1000)),
        String(this.maxAttempts)
      ],
      decoder: Decoder.Bytes
    }) as Promise<[Buffer, Buffer, number][]>;
    // NOTE: GLIDE takes no signal, so stop waiting on abort
    const aborted = Promise.withResolvers<undefined>();
    const onAbort = () => aborted.resolve(undefined);
    signal?.addEventListener('abort', onAbort);
    let rows;
    try {
      rows = await Promise.race([invocation, aborted.promise]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (!rows) {
      // NOTE: the script still runs once the server gets to it, so release what it leases then
      const release = invocation
        .then((leased) =>
          this.settle(
            0,
            leased.map(([streamID, , attempt]) => [streamID.toString(), attempt])
          )
        )
        .catch((error: unknown) => console.error('queue release failed', error));
      this.releases = Promise.all([this.releases, release]);
      return [];
    }
    const { deliveries, malformed } = decodeRows(
      rows.map(([streamID, body, attempt]): [Uint8Array, number, unknown] => [
        body,
        attempt,
        streamID.toString()
      ]),
      deadline
    );
    // NOTE: a malformed message whose ack fails returns and is dropped again
    await this.delete(malformed as string[]).catch((error: unknown) =>
      console.error('queue failed to ack malformed messages', error)
    );
    if (rows.length === 0) await sleep(EMPTY_POLL_DELAY, signal);
    return deliveries;
  }

  private async delete(streamIDs: string[]): Promise<void> {
    if (streamIDs.length === 0) return;
    await this.client.invokeScript(this.ackScript, {
      keys: [this.keys[0]],
      args: [GROUP, ...streamIDs]
    });
  }

  async ack(...deliveries: Delivery[]): Promise<void> {
    await this.delete(deliveries.map((delivery) => delivery.handle as string));
  }

  async retry(delay: number, ...deliveries: Delivery[]): Promise<void> {
    checkDelay(delay);
    await this.settle(
      delayMilliseconds(delay),
      deliveries.map((delivery) => [delivery.handle as string, delivery.attempt])
    );
  }

  private async settle(delayMs: number, leases: [string, number][]): Promise<void> {
    if (leases.length === 0) return;
    const args = [GROUP, String(delayMs), String(this.maxAttempts)];
    for (const [streamID, attempt] of leases) {
      args.push(streamID, String(attempt));
    }
    await this.client.invokeScript(this.retryScript, { keys: this.keys, args });
  }

  async close(): Promise<void> {
    try {
      await this.releases;
      await this.client.invokeScript(this.closeScript, {
        keys: [this.keys[0]],
        args: [GROUP, this.consumer]
      });
    } finally {
      this.sendScript.release();
      this.receiveScript.release();
      this.retryScript.release();
      this.closeScript.release();
      this.ackScript.release();
      this.client.close();
    }
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
    await this.publishBodies(messages.map((message) => encode(message, sentAt)));
  }

  /** Rereads the subscriptions when publish.lua reports they changed since the last read. */
  private async publishBodies(bodies: string[]): Promise<void> {
    const subscriptionsKey = `{${this.name}}:subscriptions`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const subscriptions = [...(await this.client.smembers(subscriptionsKey))].map(String).sort();
      const keys = [
        subscriptionsKey,
        ...subscriptions.map((subscription) => `{${this.name}}:${subscription}:stream`)
      ];
      try {
        await this.client.invokeScript(this.publishScript, { keys, args: bodies });
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
