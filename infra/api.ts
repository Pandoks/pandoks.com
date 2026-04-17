import { secrets } from './secrets';
import { domain, isProduction } from './dns';

const apiDomain = `api.${domain}`;
export const nodeVersion = 'nodejs22.x';

export const apiRouter = new sst.aws.Router('ApiRouter', {
  domain: {
    name: apiDomain,
    dns: sst.cloudflare.dns()
  }
});

export const blogApi = new sst.aws.Function('BlogApi', {
  handler: 'apps/functions/src/api/blog.deployHandler',
  runtime: nodeVersion,
  url: {
    router: {
      instance: apiRouter,
      path: '/blog/deploy'
    }
  },
  link: [secrets.github.BlogDeployAuth, secrets.github.PersonalAccessToken],
  environment: {
    DOMAIN: apiDomain,
    GITHUB_DEPLOY_URL:
      'https://api.github.com/repos/pandoks/pandoks.com/actions/workflows/deploy-web.yaml/dispatches'
  }
});

export const textFunction = new sst.aws.Function('TextSms', {
  handler: 'apps/functions/src/text.sendTextHandler',
  runtime: nodeVersion,
  url: false,
  link: [
    secrets.personal.KwokPhoneNumber,
    secrets.personal.MichellePhoneNumber,
    secrets.twilio.PhoneNumber,
    secrets.twilio.AccountSid,
    secrets.twilio.AuthToken,
    secrets.twilio.NotionMessagingServiceSid
  ]
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

if (isProduction) {
  new sst.aws.Function('NotionWebhookHandler', {
    handler: 'apps/functions/src/api/notion/webhook.webhookHandler',
    runtime: nodeVersion,
    timeout: '30 seconds',
    url: {
      router: {
        instance: apiRouter,
        path: '/notion/webhook'
      }
    },
    permissions: [
      {
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule'
        ],
        resources: ['*']
      },
      {
        actions: ['iam:PassRole'],
        resources: [scheduleInvokeTextRole.arn]
      },
      {
        actions: ['ssm:PutParameter'],
        resources: ['arn:aws:ssm:*:*:parameter/tmp/notion-verification-token']
      }
    ],
    environment: {
      SCHEDULER_INVOKE_ROLE_ARN: scheduleInvokeTextRole.arn,
      SCHEDULER_GROUP_NAME: scheduleTextGroup.name,
      TEXT_FUNCTION_ARN: textFunction.arn
    },
    link: [
      secrets.aws.Region,
      secrets.notion.ApiKey,
      secrets.notion.WebhookVerificationToken,
      secrets.personal.KwokPhoneNumber,
      secrets.personal.MichellePhoneNumber
    ]
  });
}
