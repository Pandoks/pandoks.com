import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import { buildSync } from 'esbuild';
import { providers, secrets } from './secrets.ts';
import { cloudflareZoneId, domain, isProduction, STAGE_NAME } from './dns.ts';
import { githubOrg, githubRepositoryName } from './github.ts';

const apiDomain = `api.${domain}`;
const NOTION_BLOG_DATABASE_ID = '20f1bb259e4b804ba24be1ceebf4c761';

function createFunction({
  id,
  name,
  entryPoint,
  handler,
  timeout,
  environment,
  inlinePolicy
}: {
  id: string;
  name: string;
  entryPoint: string;
  handler: string;
  timeout: number;
  environment: Record<string, pulumi.Input<string>>;
  inlinePolicy?: pulumi.Input<string>;
}) {
  const functionName = `${STAGE_NAME}-${name}`;
  const logGroup = new aws.cloudwatch.LogGroup(`${id}LogGroup`, {
    name: `/aws/lambda/${functionName}`,
    retentionInDays: 30
  });
  const role = new aws.iam.Role(`${id}Role`, {
    name: functionName,
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
    managedPolicyArns: [aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole],
    inlinePolicies: inlinePolicy ? [{ name: 'inline', policy: inlinePolicy }] : []
  });

  const [bundle] = buildSync({
    entryPoints: [join(import.meta.dirname, '../apps/functions/src', entryPoint)],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    write: false
  }).outputFiles;

  return new aws.lambda.Function(`${id}Function`, {
    name: functionName,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    handler: `index.${handler}`,
    role: role.arn,
    timeout,
    memorySize: 1024,
    code: new pulumi.asset.AssetArchive({
      'index.js': new pulumi.asset.StringAsset(bundle.text)
    }),
    environment: { variables: environment },
    loggingConfig: { logFormat: 'Text', logGroup: logGroup.name }
  });
}

export const textFunction = createFunction({
  id: 'TextSms',
  name: 'text-sms',
  entryPoint: 'text.ts',
  handler: 'sendTextHandler',
  timeout: 20,
  environment: {
    TWILIO_PHONE_NUMBER: secrets.twilio.PhoneNumber,
    TWILIO_ACCOUNT_SID: secrets.twilio.AccountSid,
    TWILIO_AUTH_TOKEN: secrets.twilio.AuthToken,
    TWILIO_NOTION_MESSAGING_SERVICE_SID: secrets.twilio.NotionMessagingServiceSid
  }
});

const scheduleInvokeTextRole = new aws.iam.Role('ScheduleInvokeTextRole', {
  assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: 'Allow',
        principals: [{ type: 'Service', identifiers: ['scheduler.amazonaws.com'] }],
        actions: ['sts:AssumeRole']
      }
    ]
  }).json
});
const scheduleTextGroup = new aws.scheduler.ScheduleGroup('ScheduleTextGroup', {
  name: isProduction ? 'text-scheduler' : 'text-scheduler-dev'
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
  name: 'notion-webhook-handler',
  entryPoint: 'api/notion/webhook.ts',
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
  }
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

const apiCertificate = new aws.acm.Certificate('ApiCertificate', {
  domainName: apiDomain,
  validationMethod: 'DNS'
});
const apiCertificateValidationOption = apiCertificate.domainValidationOptions[0];
const apiCertificateValidationRecord = new cloudflare.DnsRecord(
  'ApiCertificateValidationRecord',
  {
    zoneId: cloudflareZoneId,
    name: apiCertificateValidationOption.resourceRecordName,
    type: apiCertificateValidationOption.resourceRecordType,
    content: apiCertificateValidationOption.resourceRecordValue,
    proxied: false,
    ttl: 60
  },
  { provider: providers.cloudflare }
);
const apiCertificateValidation = new aws.acm.CertificateValidation('ApiCertificateValidation', {
  certificateArn: apiCertificate.arn,
  validationRecordFqdns: [apiCertificateValidationRecord.name]
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
new cloudflare.DnsRecord(
  'ApiDnsRecord',
  {
    zoneId: cloudflareZoneId,
    name: apiDomain,
    type: 'CNAME',
    content: apiDomainName.domainNameConfiguration.targetDomainName,
    proxied: false,
    ttl: 60
  },
  { provider: providers.cloudflare }
);

export const outputs = { NotionBlogDatabaseId: NOTION_BLOG_DATABASE_ID };
