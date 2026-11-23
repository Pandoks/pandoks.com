import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import { createFunction, createValidatedCertificate } from '@pandoks.com/infra/aws';
import { isProduction, STAGE_NAME } from '@pandoks.com/infra/stack';
import { secrets } from './secrets.ts';
import { cloudflareZoneId, domain } from './dns.ts';
import { githubOrg, githubRepositoryName } from './github.ts';
import type { NotionWebhookEnvironment, TextSmsEnvironment } from '../apps/functions/src/env.d.ts';

const apiDomain = `api.${domain}`;
const NOTION_BLOG_DATABASE_ID = '20f1bb259e4b804ba24be1ceebf4c761';
const functionsDirectory = join(import.meta.dirname, '../apps/functions/src');

export const textFunction = createFunction({
  id: 'TextSms',
  name: `${STAGE_NAME}-text-sms`,
  entryPoint: join(functionsDirectory, 'text.ts'),
  handler: 'sendTextHandler',
  timeout: 20,
  environment: {
    TWILIO_PHONE_NUMBER: secrets.twilio.PhoneNumber,
    TWILIO_ACCOUNT_SID: secrets.twilio.AccountSid,
    TWILIO_AUTH_TOKEN: secrets.twilio.AuthToken,
    TWILIO_NOTION_MESSAGING_SERVICE_SID: secrets.twilio.NotionMessagingServiceSid
  } satisfies Record<keyof TextSmsEnvironment, pulumi.Input<string>>
});

const scheduleInvokeTextRole = new aws.iam.Role('ScheduleInvokeTextRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'scheduler.amazonaws.com' })
});
const scheduleTextGroup = new aws.scheduler.ScheduleGroup('ScheduleTextGroup', {
  name: isProduction ? 'text-scheduler' : `text-scheduler-${STAGE_NAME}`
});
new aws.iam.RolePolicy('ScheduleInvokeTextPolicy', {
  role: scheduleInvokeTextRole.id,
  policy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        actions: ['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl'],
        resources: [textFunction.arn]
      }
    ]
  }).json
});

const notionWebhookFunction = createFunction({
  id: 'NotionWebhookHandler',
  name: `${STAGE_NAME}-notion-webhook-handler`,
  entryPoint: join(functionsDirectory, 'api/notion/webhook.ts'),
  handler: 'webhookHandler',
  timeout: 30,
  inlinePolicy: pulumi.jsonStringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule'
        ],
        Resource: '*'
      },
      { Effect: 'Allow', Action: 'iam:PassRole', Resource: scheduleInvokeTextRole.arn },
      {
        Effect: 'Allow',
        Action: 'ssm:PutParameter',
        Resource: 'arn:aws:ssm:*:*:parameter/tmp/notion-verification-token'
      }
    ]
  }),
  environment: {
    DOMAIN: apiDomain,
    SCHEDULER_INVOKE_ROLE_ARN: scheduleInvokeTextRole.arn,
    SCHEDULER_GROUP_NAME: scheduleTextGroup.name,
    TEXT_FUNCTION_ARN: textFunction.arn,
    GITHUB_NOTION_SYNC_URL: `https://api.github.com/repos/${githubOrg}/${githubRepositoryName}/actions/workflows/sync-notion.yaml/dispatches`,
    GITHUB_PERSONAL_ACCESS_TOKEN: secrets.github.PersonalAccessToken,
    NOTION_API_KEY: secrets.notion.ApiKey,
    NOTION_WEBHOOK_VERIFICATION_TOKEN: secrets.notion.WebhookVerificationToken,
    NOTION_BLOG_DATABASE_ID,
    KWOK_PHONE_NUMBER: secrets.personal.KwokPhoneNumber,
    MICHELLE_PHONE_NUMBER: secrets.personal.MichellePhoneNumber
  } satisfies Record<keyof NotionWebhookEnvironment, pulumi.Input<string>>
});

const api = new aws.apigatewayv2.Api('Api', { name: `${STAGE_NAME}-api`, protocolType: 'HTTP' });
const apiStage = new aws.apigatewayv2.Stage('ApiStage', {
  apiId: api.id,
  name: '$default',
  autoDeploy: true
});
const notionWebhookIntegration = new aws.apigatewayv2.Integration('NotionWebhookIntegration', {
  apiId: api.id,
  integrationType: 'AWS_PROXY',
  integrationMethod: 'POST',
  integrationUri: notionWebhookFunction.arn,
  payloadFormatVersion: '2.0'
});
new aws.apigatewayv2.Route('NotionWebhookRoute', {
  apiId: api.id,
  routeKey: 'ANY /notion/webhook',
  target: pulumi.interpolate`integrations/${notionWebhookIntegration.id}`
});
new aws.lambda.Permission('NotionWebhookApiPermission', {
  function: notionWebhookFunction.name,
  action: 'lambda:InvokeFunction',
  principal: 'apigateway.amazonaws.com',
  sourceArn: pulumi.interpolate`${api.executionArn}/*/*/notion/webhook`
});

const apiCertificateValidation = createValidatedCertificate({
  id: 'ApiCertificate',
  domainName: apiDomain,
  zoneId: cloudflareZoneId
});

const apiDomainName = new aws.apigatewayv2.DomainName('ApiDomainName', {
  domainName: apiDomain,
  domainNameConfiguration: {
    certificateArn: apiCertificateValidation.certificateArn,
    endpointType: 'REGIONAL',
    securityPolicy: 'TLS_1_2'
  }
});
new aws.apigatewayv2.ApiMapping('ApiMapping', {
  apiId: api.id,
  domainName: apiDomainName.id,
  stage: apiStage.id
});
new cloudflare.DnsRecord('ApiDnsRecord', {
  zoneId: cloudflareZoneId,
  name: apiDomain,
  type: 'CNAME',
  content: apiDomainName.domainNameConfiguration.targetDomainName,
  proxied: false,
  ttl: 60
});

export const outputs = { NotionBlogDatabaseId: NOTION_BLOG_DATABASE_ID };
