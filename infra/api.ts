import { secrets } from './secrets';
import { domain } from './dns';

const apiDomain = `api.${domain}`;

export const apiRouter = new sst.aws.Router('ApiRouter', {
  domain: {
    name: apiDomain,
    dns: sst.cloudflare.dns()
  }
});

export const blogApi = new sst.aws.Function('BlogApi', {
  handler: 'apps/functions/src/api/blog.deployHandler',
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

export const textFunction = new sst.aws.Function('TextSmsFunction', {
  handler: 'apps/functions/src/text.sendTextHandler',
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
  name: $app.stage === 'production' ? 'text-scheduler' : 'text-scheduler-dev'
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
export const scheduleTextReminderApi = new sst.aws.Function('ScheduleTextReminderApi', {
  handler: 'apps/functions/src/api/notion/schedule-text.scheduleTextHandler',
  url: {
    router: {
      instance: apiRouter,
      path: '/todo/remind'
    }
  },
  permissions: [
    {
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:UpdateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:GetSchedule'
      ],
      resources: ['*']
    },
    {
      actions: ['iam:PassRole'],
      resources: [scheduleInvokeTextRole.arn]
    }
  ],
  environment: {
    SCHEDULER_INVOKE_ROLE_ARN: scheduleInvokeTextRole.arn,
    SCHEDULER_GROUP_NAME: scheduleTextGroup.name,
    TEXT_FUNCTION_ARN: textFunction.arn
  },
  link: [secrets.notion.AuthToken]
});
