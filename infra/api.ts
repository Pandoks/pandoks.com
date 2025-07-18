import { secrets } from './secrets';
import { domain } from './dns';

export const apiRouter = new sst.aws.Router('ApiRouter', {
  domain: {
    name: `api.${domain}`,
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
  link: [secrets.notion.BlogDeployAuth, secrets.github.PersonalAccessToken]
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
      actions: ['sns:Publish', 'sns:SetSMSAttribute'],
      resources: ['*']
    }
  ],
  link: [
    secrets.notion.TodoRemindAuth,
    secrets.personal.KwokPhoneNumber,
    secrets.personal.MichellePhoneNumber
  ]
});

export const outputs = {
  blogApi: blogApi.url,
  todoRemindApi: todoRemindApi.url
};
