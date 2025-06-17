export const secrets = {
  notion: {
    ApiKey: new sst.Secret('NotionApiKey'),
    BlogDeployAuth: new sst.Secret('NotionBlogDeployAuth')
  },
  cloudflare: {
    ApiKey: new sst.Secret('CloudflareApiKey'),
    AccountId: new sst.Secret('CloudflareAccountId')
  },
  github: {
    PersonalAccessToken: new sst.Secret('GithubPersonalAccessToken')
  }
};
