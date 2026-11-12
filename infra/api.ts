import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import { buildSync } from 'esbuild';
import { secrets } from './secrets.ts';
import { cloudflareZoneId, domain, isProduction } from './dns.ts';
import { githubOrg, githubRepoName } from './github.ts';

const apiDomain = `api.${domain}`;
const NOTION_BLOG_DATABASE_ID = '20f1bb259e4b804ba24be1ceebf4c761';

// NOTE: aliases adopt resources SST created inside its Function and Router components.
const sstRouterUrn = pulumi.createUrn('ApiRouter', 'sst:aws:Router');
const sstRouterCdnUrn = pulumi.createUrn('ApiRouterCdn', 'sst:aws:CDN', sstRouterUrn);

function createFunction({
  name,
  entryPoint,
  handler,
  timeout,
  environment,
  inlinePolicy
}: {
  name: string;
  entryPoint: string;
  handler: string;
  timeout: number;
  environment: Record<string, pulumi.Input<string>>;
  inlinePolicy?: pulumi.Input<string>;
}) {
  const aliases = [{ parent: pulumi.createUrn(name, 'sst:aws:Function') }];
  // NOTE: keeps the random names SST gave existing resources; new stacks get a Pulumi autoname.
  const ignoreChanges = ['name'];

  const logGroup = new aws.cloudwatch.LogGroup(
    `${name}LogGroup`,
    { retentionInDays: 30 },
    { aliases, ignoreChanges }
  );
  const role = new aws.iam.Role(
    `${name}Role`,
    {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
      managedPolicyArns: [aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole],
      inlinePolicies: inlinePolicy ? [{ name: 'inline', policy: inlinePolicy }] : []
    },
    { aliases, ignoreChanges }
  );

  const [bundle] = buildSync({
    entryPoints: [join(import.meta.dirname, '../apps/functions/src', entryPoint)],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    write: false
  }).outputFiles;

  return new aws.lambda.Function(
    `${name}Function`,
    {
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
    },
    { aliases, ignoreChanges }
  );
}

export const textFunction = createFunction({
  name: 'TextSms',
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
  name: 'NotionWebhookHandler',
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
    GITHUB_NOTION_SYNC_URL: `https://api.github.com/repos/${githubOrg}/${githubRepoName}/actions/workflows/sync-notion.yaml/dispatches`,
    GITHUB_PERSONAL_ACCESS_TOKEN: secrets.github.PersonalAccessToken,
    NOTION_API_KEY: secrets.notion.ApiKey,
    NOTION_WEBHOOK_VERIFICATION_TOKEN: secrets.notion.WebhookVerificationToken,
    NOTION_BLOG_DATABASE_ID,
    KWOK_PHONE_NUMBER: secrets.personal.KwokPhoneNumber,
    MICHELLE_PHONE_NUMBER: secrets.personal.MichellePhoneNumber
  }
});

const api = new aws.apigatewayv2.Api('Api', { protocolType: 'HTTP' });
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
// NOTE: ACM reuses one validation record per domain and account, so this adopts SST's record.
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
  {
    aliases: [
      { parent: pulumi.createUrn('ApiRouterCdnSsl', 'sst:aws:Certificate', sstRouterCdnUrn) }
    ]
  }
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
  {
    aliases: [
      {
        name: `ApiRouterCdnCNAMERecord${apiDomain.replaceAll('.', '').replace(/^./, (char) => char.toUpperCase())}`,
        parent: sstRouterCdnUrn
      }
    ]
  }
);

export const outputs = { NotionBlogDatabaseId: NOTION_BLOG_DATABASE_ID };
