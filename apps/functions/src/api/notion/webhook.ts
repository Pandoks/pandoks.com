import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Resource } from 'sst';
import { handleTextReminder } from './text-reminder';

const ssmClient = new SSMClient({});

export type NotionWebhookEvent = {
  id: string;
  type: string;
  timestamp: string;
  workspace_id: string;
  subscription_id: string;
  integration_id: string;
  attempt_number: number;
  entity: {
    id: string;
    type: string;
  };
  data: Record<string, unknown>;
  verification_token?: string;
};

export const webhookHandler = async (event: APIGatewayProxyEventV2) => {
  if (event.requestContext.http.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!event.body) return new Response('Bad Request', { status: 400 });

  let body: NotionWebhookEvent;
  try {
    body = JSON.parse(event.body) as NotionWebhookEvent;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  /** INITIALIZE WEBHOOK WITH NOTION */
  if (body.verification_token) {
    const paramName = '/tmp/notion-verification-token';
    await ssmClient.send(
      new PutParameterCommand({
        Name: paramName,
        Value: body.verification_token,
        Type: 'SecureString',
        Overwrite: true
      })
    );

    const parameterUrl = `https://console.aws.amazon.com/systems-manager/parameters/${encodeURIComponent(
      encodeURIComponent(paramName)
    )}/description?region=${Resource.AwsRegion.value}`;
    console.log(
      [
        '=== NOTION WEBHOOK VERIFICATION TOKEN CAPTURED ===',
        '',
        '[URL] Open this in AWS Console:',
        parameterUrl,
        '',
        '[ACTION] Set the SST secret:',
        'pnpm exec sst secret set NotionWebhookVerificationToken --stage production <paste-token-here>',
        '',
        '[ACTION] Redeploy:',
        'pnpm exec sst deploy --stage production',
        '',
        '[REMINDER] Delete the temporary SSM parameter after the secret is set.'
      ].join('\n')
    );

    return new Response('OK', { status: 200 });
  }

  /** AUTHENTICATION */
  const signature = event.headers['x-notion-signature'] ?? event.headers['X-Notion-Signature'];
  if (!signature) return new Response('Unauthorized', { status: 401 });

  const provided = signature.replace('sha256=', '');
  const expected = createHmac('sha256', Resource.NotionWebhookVerificationToken.value)
    .update(event.body)
    .digest('hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return new Response('Unauthorized', { status: 401 });
  }

  /** ROUTE TO FEATURE HANDLERS */
  // IMPORTANT: Handlers MUST be idempotent — Notion retries the webhook on non-200 responses, so any handler that succeeded will re-run on the next attempt.
  const results = await Promise.allSettled([
    handleTextReminder(body)
    // Add new feature handlers here
  ]);

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failures.length) {
    for (const failure of failures) {
      console.error('Notion webhook handler failed', {
        eventType: body.type,
        pageId: body.entity.id,
        error: failure.reason
      });
    }
  }

  if (failures.length) {
    return new Response('Internal Server Error', { status: 500 });
  }

  return new Response('OK', { status: 200 });
};
