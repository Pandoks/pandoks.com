export const secrets = {
  notion: {
    ApiKey: new sst.Secret('NotionApiKey'),
    AuthToken: new sst.Secret('NotionAuthToken')
  },
  cloudflare: {
    ApiKey: new sst.Secret('CloudflareApiKey'),
    AccountId: new sst.Secret('CloudflareAccountId'),
    ZoneId: new sst.Secret('CloudflareZoneId'),
    Email: new sst.Secret('CloudflareEmail')
  },
  github: {
    PersonalAccessToken: new sst.Secret('GithubPersonalAccessToken'),
    BlogDeployAuth: new sst.Secret('BlogDeployAuth')
  },
  personal: {
    KwokPhoneNumber: new sst.Secret('KwokPhoneNumber'),
    MichellePhoneNumber: new sst.Secret('MichellePhoneNumber')
  },
  twilio: {
    PhoneNumber: new sst.Secret('TwilioPhoneNumber'),
    AccountSid: new sst.Secret('TwilioAccountSid'),
    AuthToken: new sst.Secret('TwilioAuthToken'),
    NotionMessagingServiceSid: new sst.Secret('TwilioNotionMessagingServiceSid')
  },
  hetzner: {
    ApiKey: new sst.Secret('HetznerApiKey'),
    TunnelSecret: new sst.Secret('HetznerTunnelSecret'),
    K3sToken: new sst.Secret('HetznerK3sToken')
  },
  k8s: {
    HetznerOriginTlsKey: new sst.Secret('HetznerOriginTlsKey', 'No Origin Tls Key Set'),
    HetznerOriginTlsCrt: new sst.Secret('HetznerOriginTlsCrt', 'No Origin Tls Cert Set'),
    PostgresPassword: new sst.Secret('PostgresPassword'),
    PostgresS3Key: new sst.Secret('PostgresS3Key', 'test'),
    PostgresS3KeySecret: new sst.Secret('PostgresS3KeySecret', 'testsecret')
  },
  planetscale: {
    ApiKey: new sst.Secret('PlanetscaleApiKey'),
    AccountId: new sst.Secret('PlanetscaleAccountId')
  }
};
