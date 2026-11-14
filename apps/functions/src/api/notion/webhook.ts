import { env } from 'cloudflare:workers';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { handleNotionBlogSync } from './gh-blog-sync';
import { handleTextReminder } from './text-reminder';

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

export const webhookHandler = async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rawBody = await request.text();
  if (!rawBody) return new Response('Bad Request', { status: 400 });

  let body: NotionWebhookEvent;
  try {
    body = JSON.parse(rawBody) as NotionWebhookEvent;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  /** INITIALIZE WEBHOOK WITH NOTION */
  if (body.verification_token) {
    await env.NOTION_VERIFICATION_TOKEN_STORE.put(
      'notion-verification-token',
      body.verification_token,
      { expirationTtl: 24 * 60 * 60 }
    );
    console.log(
      [
        '=== NOTION WEBHOOK VERIFICATION TOKEN CAPTURED ===',
        '',
        '[URL] Copy the notion-verification-token key from this KV namespace into a file within a day:',
        'https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces',
        '',
        '[ACTION] Copy it into the stack secret:',
        'aws ssm put-parameter --overwrite --type SecureString --key-id alias/pulumi-production --name /pulumi/production/NotionWebhookVerificationToken --value file://<file>',
        '',
        '[ACTION] Redeploy:',
        'gh workflow run deploy-infra.yaml -f deploy=pulumi'
      ].join('\n')
    );

    return new Response('OK', { status: 200 });
  }

  /** AUTHENTICATION */
  const signature = request.headers.get('x-notion-signature');
  if (!signature) return new Response('Unauthorized', { status: 401 });

  const provided = signature.replace('sha256=', '');
  const expected = createHmac('sha256', env.NOTION_WEBHOOK_VERIFICATION_TOKEN)
    .update(rawBody)
    .digest('hex');
  const providedBytes = new TextEncoder().encode(provided);
  const expectedBytes = new TextEncoder().encode(expected);
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return new Response('Unauthorized', { status: 401 });
  }

  /** ROUTE TO FEATURE HANDLERS */
  // WARNING: Handlers MUST be idempotent — Notion retries the webhook on non-200 responses,
  // so any handler that succeeded will re-run on the next attempt.
  const results = await Promise.allSettled([
    handleTextReminder(body),
    handleNotionBlogSync(body)
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
        error: failure.reason as unknown
      });
    }
  }

  if (failures.length) {
    return new Response('Internal Server Error', { status: 500 });
  }

  return new Response('OK', { status: 200 });
};
