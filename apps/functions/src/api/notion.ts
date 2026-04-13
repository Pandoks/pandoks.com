import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand
} from '@aws-sdk/client-scheduler';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { Client, isFullPage } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Resource } from 'sst';
import { PHONE_NUMBER_MAPPINGS, type Users } from '../lib/pii';

const notion = new Client({ auth: Resource.NotionApiKey.value });
const schedulerClient = new SchedulerClient({});
const ssmClient = new SSMClient({});
const ALL_USERS = Object.keys(PHONE_NUMBER_MAPPINGS) as Users[];
const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Assignee'];

type NotionWebhookEvent = {
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

  if (!event.body) {
    return new Response('Bad Request', { status: 400 });
  }

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

    console.log(
      [
        '✅ Notion verification token captured securely in SSM.',
        '',
        'Run these commands:',
        '',
        '# 1. Get the token and paste it into the Notion integration UI',
        `aws ssm get-parameter --name "${paramName}" --with-decryption --query "Parameter.Value" --output text`,
        '',
        '# 2. Store it as the SST secret (NotionAuthToken)',
        `sst secret set NotionAuthToken "$(aws ssm get-parameter --name '${paramName}' --with-decryption --query 'Parameter.Value' --output text)"`,
        '',
        '# 3. Delete the temporary SSM parameter',
        `aws ssm delete-parameter --name "${paramName}"`,
        '',
        '# 4. Redeploy to pick up the new secret',
        'sst deploy'
      ].join('\n')
    );

    return new Response('OK', { status: 200 });
  }

  /** AUTHENTICATION / VERIFICATION */
  const signature = event.headers['x-notion-signature'] ?? event.headers['X-Notion-Signature'];
  if (!signature) {
    return new Response('Unauthorized', { status: 401 });
  }

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
};
