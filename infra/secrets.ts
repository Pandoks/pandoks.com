import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();

export const secrets = {
  notion: {
    ApiKey: config.requireSecret('NotionApiKey'),
    WebhookVerificationToken: config.requireSecret('NotionWebhookVerificationToken')
  },
  cloudflare: {
    ApiKey: config.requireSecret('CloudflareApiKey'),
    BackupAccessKey: config.requireSecret('CloudflareBackupAccessKey'),
    BackupSecretKey: config.requireSecret('CloudflareBackupSecretKey')
  },
  github: {
    PersonalAccessToken: config.requireSecret('GithubPersonalAccessToken'),
    PackageManagementToken: config.requireSecret('GithubPackageManagementToken')
  },
  personal: {
    KwokPhoneNumber: config.requireSecret('KwokPhoneNumber'),
    MichellePhoneNumber: config.requireSecret('MichellePhoneNumber')
  },
  twilio: {
    PhoneNumber: config.requireSecret('TwilioPhoneNumber'),
    AccountSid: config.requireSecret('TwilioAccountSid'),
    AuthToken: config.requireSecret('TwilioAuthToken'),
    NotionMessagingServiceSid: config.requireSecret('TwilioNotionMessagingServiceSid')
  },
  oxylabs: {
    residential: {
      Username: config.requireSecret('OxylabsResidentialUsername'),
      Password: config.requireSecret('OxylabsResidentialPassword')
    },
    webUnblocker: {
      Username: config.requireSecret('OxylabsWebUnblockerUsername'),
      Password: config.requireSecret('OxylabsWebUnblockerPassword')
    }
  },
  hetzner: {
    ApiKey: config.requireSecret('HetznerApiKey'),
    K3sToken: config.requireSecret('HetznerK3sToken')
  },
  ovh: {
    ApplicationSecret: config.requireSecret('OvhApplicationSecret'),
    ConsumerKey: config.requireSecret('OvhConsumerKey')
  },
  tailscale: {
    OauthClientId: config.requireSecret('TailscaleOauthClientId'),
    OauthClientSecret: config.requireSecret('TailscaleOauthClientSecret')
  },
  k8s: {
    grafana: {
      AdminPassword: config.requireSecret('KubernetesGrafanaAdminPassword')
    },
    // NOTE: the key behind the CSR in infra/vps, generated once with vps.openssl.conf.
    HetznerOriginTlsKey: config.requireSecret('HetznerOriginTlsKey'),
    main: {
      // namespace
      // NOTE: names are <namespace><db-name><resource><var>, like MainMainPostgresSuperuserPassword
      mainPostgres: {
        SuperuserPassword: config.requireSecret('MainMainPostgresSuperuserPassword'),
        AdminPassword: config.requireSecret('MainMainPostgresAdminPassword'),
        ClientPassword: config.requireSecret('MainMainPostgresClientPassword'),
        ReplicationPassword: config.requireSecret('MainMainPostgresReplicationPassword'),
        PatroniPassword: config.requireSecret('MainMainPostgresPatroniPassword'),
        PgdogAdminPassword: config.requireSecret('MainMainPostgresPgdogAdminPassword')
      },
      mainValkey: {
        AdminPassword: config.requireSecret('MainMainValkeyAdminPassword'),
        ClientPassword: config.requireSecret('MainMainValkeyClientPassword')
      },
      mainClickhouse: {
        AdminPassword: config.requireSecret('MainMainClickhouseAdminPassword'),
        ClientPassword: config.requireSecret('MainMainClickhouseClientPassword')
      }
    }
  }
};

// NOTE: sync-notion.yaml reads it from production's stack outputs.
export const outputs = { NotionApiKey: secrets.notion.ApiKey };
