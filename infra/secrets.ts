import * as pulumi from '@pulumi/pulumi';

// NOTE: keyed by name, so `pnpm cluster deploy` and Argo substitute them as `${Name}`.
export const outputs: Record<string, pulumi.Output<string>> = {};

function requireSecret({
  name,
  namespace,
  key = name
}: {
  name: string;
  namespace?: string;
  key?: string;
}) {
  const value = new pulumi.Config(namespace).requireSecret(key);
  outputs[name] = value;
  return value;
}

export const secrets = {
  notion: {
    ApiKey: requireSecret({ name: 'NotionApiKey' }),
    WebhookVerificationToken: requireSecret({ name: 'NotionWebhookVerificationToken' })
  },
  cloudflare: {
    ApiKey: requireSecret({ name: 'CloudflareApiKey', namespace: 'cloudflare', key: 'apiToken' }),
    BackupAccessKey: requireSecret({ name: 'CloudflareBackupAccessKey' }),
    BackupSecretKey: requireSecret({ name: 'CloudflareBackupSecretKey' })
  },
  github: {
    PersonalAccessToken: requireSecret({
      name: 'GithubPersonalAccessToken',
      namespace: 'github',
      key: 'token'
    }),
    PackageManagementToken: requireSecret({ name: 'GithubPackageManagementToken' })
  },
  personal: {
    KwokPhoneNumber: requireSecret({ name: 'KwokPhoneNumber' }),
    MichellePhoneNumber: requireSecret({ name: 'MichellePhoneNumber' })
  },
  twilio: {
    PhoneNumber: requireSecret({ name: 'TwilioPhoneNumber' }),
    AccountSid: requireSecret({ name: 'TwilioAccountSid' }),
    AuthToken: requireSecret({ name: 'TwilioAuthToken' }),
    NotionMessagingServiceSid: requireSecret({ name: 'TwilioNotionMessagingServiceSid' })
  },
  oxylabs: {
    residential: {
      Username: requireSecret({ name: 'OxylabsResidentialUsername' }),
      Password: requireSecret({ name: 'OxylabsResidentialPassword' })
    },
    webUnblocker: {
      Username: requireSecret({ name: 'OxylabsWebUnblockerUsername' }),
      Password: requireSecret({ name: 'OxylabsWebUnblockerPassword' })
    }
  },
  hetzner: {
    ApiKey: requireSecret({ name: 'HetznerApiKey', namespace: 'hcloud', key: 'token' }),
    K3sToken: requireSecret({ name: 'HetznerK3sToken' })
  },
  ovh: {
    ApplicationSecret: requireSecret({
      name: 'OvhApplicationSecret',
      namespace: 'ovh',
      key: 'applicationSecret'
    }),
    ConsumerKey: requireSecret({ name: 'OvhConsumerKey', namespace: 'ovh', key: 'consumerKey' })
  },
  tailscale: {
    OauthClientId: requireSecret({
      name: 'TailscaleOauthClientId',
      namespace: 'tailscale',
      key: 'oauthClientId'
    }),
    OauthClientSecret: requireSecret({
      name: 'TailscaleOauthClientSecret',
      namespace: 'tailscale',
      key: 'oauthClientSecret'
    })
  },
  k8s: {
    grafana: {
      AdminPassword: requireSecret({ name: 'KubernetesGrafanaAdminPassword' })
    },
    // NOTE: the key behind the CSR in infra/vps, generated once with vps.openssl.conf.
    HetznerOriginTlsKey: requireSecret({ name: 'HetznerOriginTlsKey' }),
    main: {
      // namespace
      // NOTE: names are '<namespace><db-name><resource><var>' (ie. MainMainPostgresSuperuserPassword)
      mainPostgres: {
        SuperuserPassword: requireSecret({ name: 'MainMainPostgresSuperuserPassword' }),
        AdminPassword: requireSecret({ name: 'MainMainPostgresAdminPassword' }),
        ClientPassword: requireSecret({ name: 'MainMainPostgresClientPassword' }),
        ReplicationPassword: requireSecret({ name: 'MainMainPostgresReplicationPassword' }),
        PatroniPassword: requireSecret({ name: 'MainMainPostgresPatroniPassword' }),
        PgdogAdminPassword: requireSecret({ name: 'MainMainPostgresPgdogAdminPassword' })
      },
      mainValkey: {
        AdminPassword: requireSecret({ name: 'MainMainValkeyAdminPassword' }),
        ClientPassword: requireSecret({ name: 'MainMainValkeyClientPassword' })
      },
      mainClickhouse: {
        AdminPassword: requireSecret({ name: 'MainMainClickhouseAdminPassword' }),
        ClientPassword: requireSecret({ name: 'MainMainClickhouseClientPassword' })
      }
    }
  }
};
