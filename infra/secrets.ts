export const secrets = {
  notion: {
    ApiKey: new sst.Secret('NotionApiKey'),
    BlogDeployAuth: new sst.Secret('NotionBlogDeployAuth')
  }
};
