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
    main: {
      // namespace
      // NOTE: sst Secret names are named '<namespace>name' (ie. MainMainPostgresSuperuserPassword)
      mainPostgres: {
        SuperuserPassword: new sst.Secret('MainMainPostgresSuperuserPassword'),
        AdminPassword: new sst.Secret('MainMainPostgresAdminPassword'),
        ClientPassword: new sst.Secret('MainMainPostgresClientPassword'),
        ReplicationPassword: new sst.Secret('MainMainPostgresReplicationPassword'),
        PatroniPassword: new sst.Secret('MainMainPostgresPatroniPassword'),
        S3Key: new sst.Secret('MainMainPostgresS3Key', 'test'),
        S3KeySecret: new sst.Secret('MainMainPostgresS3KeySecret', 'testsecret')
      },
      mainValkey: {
        ValkeyAdminPassword: new sst.Secret('ValkeyAdminPassword'),
        ValkeyClientPassword: new sst.Secret('ValkeyClientPassword')
      },
      mainClickhouse: {
        ClickhouseAdminPassword: new sst.Secret('ClickhouseAdminPassword'),
        ClickhouseUserPassword: new sst.Secret('ClickhouseUserPassword'),
        ClickhouseBackupPassword: new sst.Secret('ClickhouseBackupPassword'),
        ClickhouseS3Key: new sst.Secret('ClickhouseS3Key', 'test'),
        ClickhouseS3KeySecret: new sst.Secret('ClickhouseS3KeySecret', 'testsecret')
      }
    }
  }
};
