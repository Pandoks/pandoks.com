export const secrets = {
  notion: {
    ApiKey: new sst.Secret('NotionApiKey'),
    BlogDeployAuth: new sst.Secret('NotionBlogDeployAuth'),
    TodoRemindAuth: new sst.Secret('NotionTodoRemindAuth')
  },
  cloudflare: {
    ApiKey: new sst.Secret('CloudflareApiKey'),
    AccountId: new sst.Secret('CloudflareAccountId')
  },
  github: {
    PersonalAccessToken: new sst.Secret('GithubPersonalAccessToken')
  },
  personal: {
    KwokPhoneNumber: new sst.Secret('KwokPhoneNumber'),
    MichellePhoneNumber: new sst.Secret('MichellePhoneNumber')
  },
  twilio: {
    PhoneNumber: new sst.Secret('TwilioPhoneNumber'),
    AccountSid: new sst.Secret('TwilioAccountSid'),
    AuthToken: new sst.Secret('TwilioAuthToken')
  }
};
