import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cloudflare from '@pulumi/cloudflare';
import { secrets } from './secrets.ts';
import { cloudflareAccountId, cloudflareZoneId, domain, STAGE_NAME } from './dns.ts';

const functionsDirectory = join(import.meta.dirname, '../apps/functions');
const wranglerConfig = JSON.parse(
  readFileSync(join(functionsDirectory, 'wrangler.json'), 'utf8')
) as {
  compatibility_date: string;
  compatibility_flags: string[];
  vars: { NOTION_BLOG_DATABASE_ID: string };
};

// NOTE: wrangler bundles the Worker the same way for `wrangler dev` and for this deploy
const bundleDirectory = mkdtempSync(join(tmpdir(), 'api-worker-'));
execFileSync(
  join(import.meta.dirname, '../node_modules/.bin/wrangler'),
  ['deploy', '--dry-run', '--outdir', bundleDirectory],
  { cwd: functionsDirectory, stdio: ['ignore', 'ignore', 'inherit'] }
);
const apiWorkerBundle = readFileSync(join(bundleDirectory, 'index.js'), 'utf8');
rmSync(bundleDirectory, { recursive: true });

const textReminderWorkflowName = `${STAGE_NAME}-text-reminder`;
const notionVerificationTokenStore = new cloudflare.WorkersKvNamespace(
  'NotionVerificationTokenStore',
  { accountId: cloudflareAccountId, title: `${STAGE_NAME}-notion-verification-token` }
);

const secretBindings = {
  GITHUB_PERSONAL_ACCESS_TOKEN: secrets.github.PersonalAccessToken,
  NOTION_API_KEY: secrets.notion.ApiKey,
  NOTION_WEBHOOK_VERIFICATION_TOKEN: secrets.notion.WebhookVerificationToken,
  TWILIO_PHONE_NUMBER: secrets.twilio.PhoneNumber,
  TWILIO_ACCOUNT_SID: secrets.twilio.AccountSid,
  TWILIO_AUTH_TOKEN: secrets.twilio.AuthToken,
  TWILIO_NOTION_MESSAGING_SERVICE_SID: secrets.twilio.NotionMessagingServiceSid,
  KWOK_PHONE_NUMBER: secrets.personal.KwokPhoneNumber,
  MICHELLE_PHONE_NUMBER: secrets.personal.MichellePhoneNumber
};

const apiWorker = new cloudflare.WorkersScript('ApiWorker', {
  accountId: cloudflareAccountId,
  scriptName: `${STAGE_NAME}-api`,
  content: apiWorkerBundle,
  mainModule: 'index.js',
  compatibilityDate: wranglerConfig.compatibility_date,
  compatibilityFlags: wranglerConfig.compatibility_flags,
  observability: { enabled: true },
  bindings: [
    {
      type: 'workflow',
      name: 'TEXT_REMINDER_WORKFLOW',
      workflowName: textReminderWorkflowName,
      className: 'TextReminderWorkflow'
    },
    {
      type: 'kv_namespace',
      name: 'NOTION_VERIFICATION_TOKEN_STORE',
      namespaceId: notionVerificationTokenStore.id
    },
    ...Object.entries(wranglerConfig.vars).map(([name, text]) => ({
      type: 'plain_text',
      name,
      text
    })),
    ...Object.entries(secretBindings).map(([name, text]) => ({ type: 'secret_text', name, text }))
  ]
});

new cloudflare.Workflow('TextReminderWorkflow', {
  accountId: cloudflareAccountId,
  workflowName: textReminderWorkflowName,
  className: 'TextReminderWorkflow',
  scriptName: apiWorker.scriptName
});

new cloudflare.WorkersCustomDomain('ApiDomain', {
  accountId: cloudflareAccountId,
  zoneId: cloudflareZoneId,
  hostname: `api.${domain}`,
  service: apiWorker.scriptName
});

export const outputs = { NotionBlogDatabaseId: wranglerConfig.vars.NOTION_BLOG_DATABASE_ID };
