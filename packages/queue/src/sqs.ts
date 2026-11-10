// SQS queues; credentials come from the AWS SDK's default chain.
import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient
} from '@aws-sdk/client-sqs';
import {
  batches,
  checkDelay,
  checkFailed,
  decodeRows,
  delaySeconds,
  encode,
  parseLease,
  queryParams,
  type Delivery,
  type Message,
  type Queue
} from './envelope.ts';

const BATCH_COUNT = 10;
const BATCH_BYTES = 1 << 20;
const WAIT_SECONDS = 20;
const HOST = /^sqs\.([a-z0-9-]+)\.amazonaws\.com$/;
const PATH = /^\/[^/]+\/[^/]+$/;

export function openQueue(url: URL): SQSQueue {
  const region = HOST.exec(url.host);
  if (!region || url.username || url.password || !PATH.test(decodeURIComponent(url.pathname))) {
    throw new Error('awssqs URL must be awssqs://sqs.<region>.amazonaws.com/<account>/<name>');
  }
  const params = queryParams(url, 'lease', 'endpoint');
  const lease = parseLease(url, params);
  if (!Number.isInteger(lease)) {
    throw new Error(`awssqs URL: lease ${params.lease} must be whole seconds`);
  }
  const client = new SQSClient({ region: region[1], endpoint: params.endpoint });
  return new SQSQueue(client, `https://${url.host}${url.pathname}`, lease);
}

export class SQSQueue implements Queue {
  client: SQSClient;
  url: string;
  lease: number;

  constructor(client: SQSClient, url: string, lease: number) {
    this.client = client;
    this.url = url;
    this.lease = lease;
  }

  async send(...messages: Message[]): Promise<void> {
    const sentAt = new Date();
    // NOTE: like Go's SDK, leave DelaySeconds out for no delay, so SQS applies the queue's default
    const entries = messages.map((message, index) => ({
      Id: String(index),
      MessageBody: encode(message, sentAt),
      DelaySeconds: message.delay ? delaySeconds(message.delay) : undefined
    }));
    const size = (entry: { MessageBody: string }) => Buffer.byteLength(entry.MessageBody);
    for (const batch of batches(entries, size, BATCH_COUNT, BATCH_BYTES)) {
      const output = await this.client.send(
        new SendMessageBatchCommand({ QueueUrl: this.url, Entries: batch })
      );
      checkFailed('send to SQS', output.Failed);
    }
  }

  async receive(max: number, signal?: AbortSignal): Promise<Delivery[]> {
    if (max < 1) throw new Error(`receive from SQS: max ${max} must be at least 1`);
    let output;
    try {
      output = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.url,
          MaxNumberOfMessages: Math.min(max, BATCH_COUNT),
          WaitTimeSeconds: WAIT_SECONDS,
          VisibilityTimeout: this.lease,
          MessageSystemAttributeNames: ['ApproximateReceiveCount']
        }),
        { abortSignal: signal }
      );
    } catch (error) {
      if (signal?.aborted) return [];
      throw error;
    }
    // NOTE: the visibility timeout starts when the long poll returns a message
    const deadline = new Date(Date.now() + this.lease * 1000);
    const rows = (output.Messages ?? []).map((message): [string, number, unknown] => [
      message.Body!,
      Number(message.Attributes!.ApproximateReceiveCount),
      message.ReceiptHandle
    ]);
    const { deliveries, malformed } = decodeRows(rows, deadline);
    await this.delete(malformed);
    return deliveries;
  }

  private async delete(handles: unknown[]): Promise<void> {
    for (const batch of batches(handles, () => 0, BATCH_COUNT, Infinity)) {
      const entries = batch.map((handle, index) => ({
        Id: String(index),
        ReceiptHandle: handle as string
      }));
      const output = await this.client.send(
        new DeleteMessageBatchCommand({ QueueUrl: this.url, Entries: entries })
      );
      checkFailed('ack SQS messages', output.Failed);
    }
  }

  async ack(...deliveries: Delivery[]): Promise<void> {
    await this.delete(deliveries.map((delivery) => delivery.handle));
  }

  async retry(delay: number, ...deliveries: Delivery[]): Promise<void> {
    checkDelay(delay);
    for (const batch of batches(deliveries, () => 0, BATCH_COUNT, Infinity)) {
      const entries = batch.map((delivery, index) => ({
        Id: String(index),
        ReceiptHandle: delivery.handle as string,
        VisibilityTimeout: delaySeconds(delay)
      }));
      const output = await this.client.send(
        new ChangeMessageVisibilityBatchCommand({ QueueUrl: this.url, Entries: entries })
      );
      checkFailed('retry SQS messages', output.Failed);
    }
  }

  close(): Promise<void> {
    this.client.destroy();
    return Promise.resolve();
  }
}
