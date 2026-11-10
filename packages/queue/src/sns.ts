// SNS topics whose subscriptions are SQS queues with raw delivery on.
import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';
import { batches, encode, queryParams, type Message, type Topic } from './envelope.ts';
import { BATCH_COUNT, checkFailed } from './sqs.ts';

const BATCH_BYTES = 256 << 10;

export function openTopic(url: URL): SNSTopic {
  const params = queryParams(url, 'endpoint');
  const arn = url.pathname.replace(/^\//, '');
  const fields = arn.split(':');
  if (fields.length !== 6 || fields[0] !== 'arn' || fields[2] !== 'sns') {
    throw new Error(`awssns URL: path ${arn} must be a topic ARN`);
  }
  return new SNSTopic(new SNSClient({ region: fields[3], endpoint: params.endpoint }), arn);
}

export class SNSTopic implements Topic {
  client: SNSClient;
  arn: string;

  constructor(client: SNSClient, arn: string) {
    this.client = client;
    this.arn = arn;
  }

  async publish(...messages: Message[]): Promise<void> {
    if (messages.some((message) => message.delay)) {
      throw new Error('publish to SNS: topics take no delay');
    }
    const sentAt = new Date();
    const entries = messages.map((message, index) => ({
      Id: String(index),
      Message: encode(message, sentAt)
    }));
    const size = (entry: { Message: string }) => Buffer.byteLength(entry.Message);
    for (const batch of batches(entries, size, BATCH_COUNT, BATCH_BYTES)) {
      const output = await this.client.send(
        new PublishBatchCommand({ TopicArn: this.arn, PublishBatchRequestEntries: batch })
      );
      checkFailed('publish to SNS', output.Failed);
    }
  }

  close(): Promise<void> {
    this.client.destroy();
    return Promise.resolve();
  }
}
