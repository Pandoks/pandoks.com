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
      // NOTE: sst Secret names are named '<namespace><db-name><resource><var>' (ie. MainMainPostgresSuperuserPassword)
      mainPostgres: {
        SuperuserPassword: new sst.Secret('MainMainPostgresSuperuserPassword'),
        AdminPassword: new sst.Secret('MainMainPostgresAdminPassword'),
        ClientPassword: new sst.Secret('MainMainPostgresClientPassword'),
        ReplicationPassword: new sst.Secret('MainMainPostgresReplicationPassword'),
        PatroniPassword: new sst.Secret('MainMainPostgresPatroniPassword'),
        PgdogAdminPassword: new sst.Secret('MainMainPostgresPgdogAdminPassword'),
        BackupS3Key: new sst.Secret('MainMainPostgresBackupS3Key', 'test'),
        BackupS3KeySecret: new sst.Secret('MainMainPostgresBackupS3KeySecret', 'testsecret')
      },
      mainValkey: {
        AdminPassword: new sst.Secret('MainMainValkeyAdminPassword'),
        ClientPassword: new sst.Secret('MainMainValkeyClientPassword')
      },
      mainClickhouse: {
        AdminPassword: new sst.Secret('MainMainClickhouseAdminPassword'),
        ClientPassword: new sst.Secret('MainMainClickhouseClientPassword'),
        BackupS3Key: new sst.Secret('MainMainClickhouseBackupS3Key', 'test'),
        BackupS3KeySecret: new sst.Secret('MainMainClickhouseBackupS3KeySecret', 'testsecret')
      }
    }
  }
};
