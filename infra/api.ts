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
  link: [secrets.notion.BlogDeployAuth, secrets.github.PersonalAccessToken],
  environment: {
    DOMAIN: apiDomain,
    GITHUB_DEPLOY_URL:
      'https://api.github.com/repos/pandoks/pandoks.com/actions/workflows/deploy-web.yaml/dispatches'
  }
});

const todoInvokeRole = new aws.iam.Role('TodoInvokeRole', {
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
export const todoRemindApi = new sst.aws.Function('TodoRemindApi', {
  handler: 'apps/functions/src/api/todo.textTodoHandler',
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
      resources: [todoInvokeRole.arn]
    }
  ],
  environment: {
    SCHEDULER_INVOKE_ROLE_ARN: todoInvokeRole.arn,
    SCHEDULER_GROUP_NAME: 'todo-reminders'
  },
  link: [
    secrets.notion.TodoRemindAuth,
    secrets.personal.KwokPhoneNumber,
    secrets.personal.MichellePhoneNumber,
    secrets.twilio.PhoneNumber,
    secrets.twilio.AccountSid,
    secrets.twilio.AuthToken,
    secrets.twilio.NotionMessagingServiceSid
  ]
});
todoRemindApi.addEnvironment({ WORKER_ARN: todoRemindApi.arn });
new aws.iam.RolePolicy('TodoInvokePolicy', {
  role: todoInvokeRole.id,
  policy: aws.iam.getPolicyDocumentOutput({
    statements: [
      { effect: 'Allow', actions: ['lambda:InvokeFunction'], resources: [todoRemindApi.arn] }
    ]
  }).json
});

export const outputs = {
  blogApi: blogApi.url,
  todoRemindApi: todoRemindApi.url
};
