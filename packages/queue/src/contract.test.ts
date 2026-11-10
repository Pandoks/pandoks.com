// The contract every adapter meets, against compose.yaml's brokers and, in CI, Cloudflare.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { GlideClusterClient } from '@valkey/valkey-glide';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { decode, encode, type Delivery, type Message, type Queue, type Topic } from './envelope.ts';
import { openQueue, openTopic } from './index.ts';

const VALKEY = '127.0.0.1:16379';
const MOTO_ENDPOINT = 'http://127.0.0.1:15000';
const MOTO_ACCOUNT = '123456789012';
const REGION = 'us-west-1';
const WAIT = 30;
const fixtures = new URL('../testdata/envelopes/', import.meta.url);

interface Broker {
  lease: number;
  maxAttempts: number;
  queue: Queue;
  deadLetters: () => Promise<string[]>;
  topic: Topic;
  subscriptions: Queue[];
  close: () => Promise<void>;
}

function suffix(): string {
  return randomBytes(5).toString('hex');
}

function testMessage(name: string): Message & { id: string } {
  return {
    id: `${name}-${suffix()}`,
    source: '//pandoks.com/queue/test',
    type: 'com.pandoks.queue.test',
    data: new TextEncoder().encode(JSON.stringify({ case: name }))
  };
}

/**
 * Collects deliveries of the wanted ids until all arrive or timeout seconds pass, acking any
 * other message (a leftover from an earlier run).
 */
async function receive(queue: Queue, timeout: number, ...ids: string[]) {
  const signal = AbortSignal.timeout(timeout * 1000);
  const got: Record<string, Delivery> = {};
  while (Object.keys(got).length < ids.length && !signal.aborted) {
    for (const delivery of await queue.receive(10, signal)) {
      if (ids.includes(delivery.id)) got[delivery.id] = delivery;
      else await queue.ack(delivery);
    }
  }
  return got;
}

async function receivedIDs(queue: Queue): Promise<string[]> {
  const deliveries = await queue.receive(10, AbortSignal.timeout(WAIT * 1000));
  await queue.ack(...deliveries);
  return deliveries.map((delivery) => delivery.id);
}

async function valkeyBroker(): Promise<Broker> {
  const name = suffix();
  const base = `valkey://client:client@${VALKEY}/`;
  const client = await GlideClusterClient.createClient({
    addresses: [{ host: '127.0.0.1', port: 16379 }],
    credentials: { username: 'client', password: 'client' }
  });
  const opened = await Promise.all([
    openQueue(`${base}q${name}?lease=500ms&max_attempts=3`),
    openQueue(`${base}t${name}?subscription=a&lease=500ms&max_attempts=3`),
    openQueue(`${base}t${name}?subscription=b&lease=500ms&max_attempts=3`)
  ]);
  const topic = await openTopic(`${base}t${name}`);
  return {
    lease: 0.5,
    maxAttempts: 3,
    queue: opened[0],
    subscriptions: opened.slice(1),
    topic,
    deadLetters: async () => {
      const entries = (await client.xrange(`{q${name}}:dlq`, { value: '-' }, { value: '+' })) ?? {};
      return Object.values(entries).map((fields) => {
        const envelope = fields.find(([field]) => field === 'envelope')![1];
        return decode(String(envelope), { attempt: 0, deadline: new Date(), handle: undefined }).id;
      });
    },
    close: async () => {
      await Promise.all([...opened.map((queue) => queue.close()), topic.close()]);
      client.close();
    }
  };
}

async function sqsBroker(): Promise<Broker> {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  const sqs = new SQSClient({ region: REGION, endpoint: MOTO_ENDPOINT });
  const sns = new SNSClient({ region: REGION, endpoint: MOTO_ENDPOINT });
  const name = suffix();
  const createQueue = async (queueName: string, attributes?: Record<string, string>) => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: queueName, Attributes: attributes })
    );
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] })
    );
    return Attributes!.QueueArn!;
  };
  const queueURL = (queueName: string) =>
    `awssqs://sqs.${REGION}.amazonaws.com/${MOTO_ACCOUNT}/${queueName}?lease=1s&endpoint=${MOTO_ENDPOINT}`;

  const dlqARN = await createQueue(`dlq-${name}`);
  await createQueue(`q-${name}`, {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqARN, maxReceiveCount: '3' })
  });
  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: `t-${name}` }));
  const subscriptions: Queue[] = [];
  for (const subscription of ['a', 'b']) {
    const arn = await createQueue(`t-${name}-${subscription}`);
    await sns.send(
      new SubscribeCommand({
        TopicArn,
        Protocol: 'sqs',
        Endpoint: arn,
        Attributes: { RawMessageDelivery: 'true' }
      })
    );
    subscriptions.push(await openQueue(queueURL(`t-${name}-${subscription}`)));
  }
  const queue = await openQueue(queueURL(`q-${name}`));
  const dlq = await openQueue(queueURL(`dlq-${name}`));
  const topic = await openTopic(`awssns:///${TopicArn}?endpoint=${MOTO_ENDPOINT}`);
  return {
    lease: 1,
    maxAttempts: 3,
    queue,
    subscriptions,
    topic,
    deadLetters: () => receivedIDs(dlq),
    close: async () => {
      await Promise.all([queue, dlq, ...subscriptions, topic].map((opened) => opened.close()));
      sqs.destroy();
      sns.destroy();
    }
  };
}

// Queues the CI job creates, each with an HTTP pull consumer; the main queue dead-letters to
// the second after max_retries 2.
async function cloudflareBroker(): Promise<Broker> {
  const base = `cloudflare://${process.env.CLOUDFLARE_ACCOUNT_ID}/`;
  const queueID = process.env.QUEUE_TEST_CLOUDFLARE_QUEUE;
  const subscriptionID = process.env.QUEUE_TEST_CLOUDFLARE_SUBSCRIPTION;
  const dlq = await openQueue(`${base}${process.env.QUEUE_TEST_CLOUDFLARE_DLQ}?lease=5s`);
  return {
    lease: 5,
    maxAttempts: 3,
    queue: await openQueue(`${base}${queueID}?lease=5s`),
    subscriptions: [
      await openQueue(`${base}${queueID}?lease=5s`),
      await openQueue(`${base}${subscriptionID}?lease=5s`)
    ],
    topic: await openTopic(`${base}${queueID},${subscriptionID}`),
    deadLetters: () => receivedIDs(dlq),
    close: async () => {}
  };
}

const brokers: [string, () => Promise<Broker>, boolean][] = [
  ['valkey', valkeyBroker, true],
  ['sqs', sqsBroker, true],
  ['cloudflare', cloudflareBroker, Boolean(process.env.QUEUE_TEST_CLOUDFLARE_QUEUE)]
];

describe.each(brokers)('%s contract', { timeout: 120_000 }, (_, open, enabled) => {
  let broker: Broker;
  beforeAll(async () => {
    if (enabled) broker = await open();
  });
  afterAll(async () => {
    await broker?.close();
    vi.unstubAllEnvs();
  });

  test.runIf(enabled)('sends, receives, and acks golden envelopes', async () => {
    const sent: Record<string, Message> = {};
    for (const name of readdirSync(fixtures)) {
      const body = readFileSync(new URL(name, fixtures), 'utf8');
      const fixture = decode(body, { attempt: 1, deadline: new Date(), handle: undefined });
      const id = `${fixture.id}-${suffix()}`;
      sent[id] = {
        id,
        source: fixture.source,
        type: fixture.type,
        data: fixture.data,
        contentType: fixture.contentType,
        extensions: fixture.extensions
      };
    }
    await broker.queue.send(...Object.values(sent));
    const got = await receive(broker.queue, WAIT, ...Object.keys(sent));
    expect(Object.keys(got).sort()).toEqual(Object.keys(sent).sort());
    for (const [id, message] of Object.entries(sent)) {
      const delivery = got[id];
      expect(delivery.attempt).toBe(1);
      expect(Date.now() - delivery.time.getTime()).toBeLessThan(60_000);
      expect(delivery.deadline.getTime() - Date.now()).toBeLessThanOrEqual(broker.lease * 1000);
      expect(JSON.parse(encode(delivery, delivery.time))).toEqual(
        JSON.parse(encode(message, delivery.time))
      );
      await broker.queue.ack(delivery);
    }
    expect(await receive(broker.queue, 2 * broker.lease + 1, ...Object.keys(sent))).toEqual({});
  });

  test.runIf(enabled)('retry comes back after its delay as the next attempt', async () => {
    const message = testMessage('retry');
    await broker.queue.send(message);
    const first = (await receive(broker.queue, WAIT, message.id))[message.id];
    const retriedAt = Date.now();
    await broker.queue.retry(2, first);
    const second = (await receive(broker.queue, WAIT, message.id))[message.id];
    expect(Date.now() - retriedAt).toBeGreaterThanOrEqual(2000);
    // NOTE: relative, since an SQS long poll cancelled by an earlier check can still take it once
    expect(second.attempt).toBe(first.attempt + 1);
    await broker.queue.ack(second);
  });

  test.runIf(enabled)('an expired lease redelivers as the next attempt', async () => {
    const message = { ...testMessage('lease'), delay: 1 };
    const sentAt = Date.now();
    await broker.queue.send(message);
    const first = (await receive(broker.queue, WAIT, message.id))[message.id];
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1000);
    const second = (await receive(broker.queue, WAIT, message.id))[message.id];
    expect(second.attempt).toBe(first.attempt + 1);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1000 + broker.lease * 1000);
    await broker.queue.ack(second);
  });

  test.runIf(enabled)('dead-letters after the last attempt', async () => {
    const message = testMessage('dead');
    await broker.queue.send(message);
    for (let attempt = 1; attempt <= broker.maxAttempts; attempt++) {
      const delivery = (await receive(broker.queue, WAIT, message.id))[message.id];
      expect(delivery.attempt).toBe(attempt);
      await broker.queue.retry(0, delivery);
    }
    expect(await receive(broker.queue, 2 * broker.lease + 1, message.id)).toEqual({});
    expect(await broker.deadLetters()).toContain(message.id);
  });

  test.runIf(enabled)('a topic reaches every subscription', async () => {
    const message = testMessage('topic');
    await expect(broker.topic.publish({ ...message, delay: 1 })).rejects.toThrow();
    await broker.topic.publish(message);
    for (const subscription of broker.subscriptions) {
      const delivery = (await receive(subscription, WAIT, message.id))[message.id];
      expect(delivery).toBeDefined();
      await subscription.ack(delivery);
    }
  });
});
