import { expect, test, vi } from 'vitest';

test('an SNS topic opens without the optional SQS peer', async () => {
  vi.doMock('@aws-sdk/client-sqs', () => {
    throw new Error('@aws-sdk/client-sqs is not installed');
  });
  const { openTopic } = await import('./index.ts');
  const topic = await openTopic('awssns:///arn:aws:sns:us-west-1:123456789012:t');
  expect(topic).toHaveProperty('arn', 'arn:aws:sns:us-west-1:123456789012:t');
  await topic.close();
});
