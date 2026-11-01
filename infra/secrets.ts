import { execSync } from 'node:child_process';

// Local copy to avoid a cycle with dns.ts, which imports this module.
const IS_PRODUCTION = $app.stage === 'production';

export const secrets = {
  Stage: new sst.Secret('StageName', 'dev'), // Automatically set during deploy
  notion: {
    ApiKey: new sst.Secret('NotionApiKey'),
    WebhookVerificationToken: new sst.Secret('NotionWebhookVerificationToken')
  },
  aws: {
    Region: new sst.Secret('AwsRegion', 'us-west-1')
  },
  cloudflare: {
    ApiKey: new sst.Secret('CloudflareApiKey'),
    BackupAccessKey: new sst.Secret('CloudflareBackupAccessKey'),
    BackupSecretKey: new sst.Secret('CloudflareBackupSecretKey')
  },
  deepinfra: {
    // Only the production scaler reads these. Non-production stages get a placeholder so their
    // deploy/diff doesn't fail; production has no fallback (a `Placeholder` wake token would be a
    // valid credential for the public endpoint), so it must be set explicitly with
    // `pnpm sst secret set ... --stage production`.
    ApiKey: new sst.Secret('DeepinfraApiKey', IS_PRODUCTION ? undefined : 'Placeholder'),
    RedSnowWakeToken: new sst.Secret('RedSnowWakeToken', IS_PRODUCTION ? undefined : 'Placeholder')
  },
  github: {
    PersonalAccessToken: new sst.Secret('GithubPersonalAccessToken'),
    PackageManagementToken: new sst.Secret('GithubPackageManagementToken')
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
  oxylabs: {
    residential: {
      Username: new sst.Secret('OxylabsResidentialUsername'),
      Password: new sst.Secret('OxylabsResidentialPassword')
    },
    webUnblocker: {
      Username: new sst.Secret('OxylabsWebUnblockerUsername'),
      Password: new sst.Secret('OxylabsWebUnblockerPassword')
    }
  },
  hetzner: {
    ApiKey: new sst.Secret('HetznerApiKey'),
    K3sToken: new sst.Secret('HetznerK3sToken')
  },
  ovh: {
    ApplicationSecret: new sst.Secret('OvhApplicationSecret'),
    ConsumerKey: new sst.Secret('OvhConsumerKey')
  },
  tailscale: {
    OauthClientId: new sst.Secret('TailscaleOauthClientId'),
    OauthClientSecret: new sst.Secret('TailscaleOauthClientSecret')
  },
  k8s: {
    tailscale: {
      OauthClientId: new sst.Secret('KubernetesTailscaleOauthClientId', 'Placeholder'), // Automatically set during deploy
      OauthClientSecret: new sst.Secret('KubernetesTailscaleOauthClientSecret', 'Placeholder') // Automatically set during deploy
    },
    argocd: {
      AccessKeyId: new sst.Secret('KubernetesArgocdAccessKeyId', 'Placeholder'), // Automatically set during deploy
      SecretAccessKey: new sst.Secret('KubernetesArgocdSecretAccessKey', 'Placeholder') // Automatically set during deploy
    },
    grafana: {
      AdminPassword: new sst.Secret('KubernetesGrafanaAdminPassword', 'password')
    },
    HetznerOriginTlsKey: new sst.Secret('HetznerOriginTlsKey', 'No Origin Tls Key Set'), // Automatically set during deploy
    HetznerOriginTlsCrt: new sst.Secret('HetznerOriginTlsCrt', 'No Origin Tls Cert Set'), // Automatically set during deploy
    main: {
      // namespace
      // NOTE: sst Secret names are named '<namespace><db-name><resource><var>' (ie. MainMainPostgresSuperuserPassword)
      mainPostgres: {
        SuperuserPassword: new sst.Secret('MainMainPostgresSuperuserPassword'),
        AdminPassword: new sst.Secret('MainMainPostgresAdminPassword'),
        ClientPassword: new sst.Secret('MainMainPostgresClientPassword'),
        ReplicationPassword: new sst.Secret('MainMainPostgresReplicationPassword'),
        PatroniPassword: new sst.Secret('MainMainPostgresPatroniPassword'),
        PgdogAdminPassword: new sst.Secret('MainMainPostgresPgdogAdminPassword')
      },
      mainValkey: {
        AdminPassword: new sst.Secret('MainMainValkeyAdminPassword'),
        ClientPassword: new sst.Secret('MainMainValkeyClientPassword')
      },
      mainClickhouse: {
        AdminPassword: new sst.Secret('MainMainClickhouseAdminPassword'),
        ClientPassword: new sst.Secret('MainMainClickhouseClientPassword')
      }
    }
  }
};

export function setSecret(secretName: $util.Input<string>, secretValue: $util.Input<string>) {
  $resolve([secretName, secretValue]).apply(([name, value]) => {
    execSync(`sst secret set ${name} --stage ${$app.stage} ${value}`, {
      stdio: 'inherit'
    });
  });
}
