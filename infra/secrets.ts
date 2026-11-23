import * as pulumi from '@pulumi/pulumi';
import { isProduction } from '@pandoks.com/infra/stack';

// NOTE: keyed by name, so `pnpm cluster deploy` and Argo substitute them as `${Name}`.
export const outputs: Record<string, pulumi.Output<string>> = {};

const config = new pulumi.Config();

function requireSecret(name: string) {
  const value = config.requireSecret(name);
  outputs[name] = value;
  return value;
}

export const productionSecrets = isProduction
  ? {
      github: {
        GeminiAppPrivateKey: config.requireSecret('GithubGeminiAppPrivateKey')
      }
    }
  : undefined;

export const secrets = {
  notion: {
    ApiKey: requireSecret('NotionApiKey'),
    WebhookVerificationToken: requireSecret('NotionWebhookVerificationToken')
  },
  cloudflare: {
    ApiKey: requireSecret('CloudflareApiKey'),
    BackupAccessKey: requireSecret('CloudflareBackupAccessKey'),
    BackupSecretKey: requireSecret('CloudflareBackupSecretKey')
  },
  github: {
    PersonalAccessToken: requireSecret('GithubPersonalAccessToken'),
    PackageManagementToken: requireSecret('GithubPackageManagementToken')
  },
  personal: {
    KwokPhoneNumber: requireSecret('KwokPhoneNumber'),
    MichellePhoneNumber: requireSecret('MichellePhoneNumber')
  },
  twilio: {
    PhoneNumber: requireSecret('TwilioPhoneNumber'),
    AccountSid: requireSecret('TwilioAccountSid'),
    AuthToken: requireSecret('TwilioAuthToken'),
    NotionMessagingServiceSid: requireSecret('TwilioNotionMessagingServiceSid')
  },
  oxylabs: {
    residential: {
      Username: requireSecret('OxylabsResidentialUsername'),
      Password: requireSecret('OxylabsResidentialPassword')
    },
    webUnblocker: {
      Username: requireSecret('OxylabsWebUnblockerUsername'),
      Password: requireSecret('OxylabsWebUnblockerPassword')
    }
  },
  hetzner: {
    ApiKey: requireSecret('HetznerApiKey'),
    K3sToken: requireSecret('HetznerK3sToken')
  },
  ovh: {
    ApplicationSecret: requireSecret('OvhApplicationSecret'),
    ConsumerKey: requireSecret('OvhConsumerKey')
  },
  tailscale: {
    OauthClientId: requireSecret('TailscaleOauthClientId'),
    OauthClientSecret: requireSecret('TailscaleOauthClientSecret')
  },
  k8s: {
    grafana: {
      AdminPassword: requireSecret('KubernetesGrafanaAdminPassword')
    },
    // NOTE: the key behind the CSR in infra/vps, generated once with vps.openssl.conf.
    HetznerOriginTlsKey: requireSecret('HetznerOriginTlsKey'),
    main: {
      // namespace
      // NOTE: names are <namespace><db-name><resource><var>, like MainMainPostgresSuperuserPassword
      mainPostgres: {
        SuperuserPassword: requireSecret('MainMainPostgresSuperuserPassword'),
        AdminPassword: requireSecret('MainMainPostgresAdminPassword'),
        ClientPassword: requireSecret('MainMainPostgresClientPassword'),
        ReplicationPassword: requireSecret('MainMainPostgresReplicationPassword'),
        PatroniPassword: requireSecret('MainMainPostgresPatroniPassword'),
        PgdogAdminPassword: requireSecret('MainMainPostgresPgdogAdminPassword')
      },
      mainValkey: {
        AdminPassword: requireSecret('MainMainValkeyAdminPassword'),
        ClientPassword: requireSecret('MainMainValkeyClientPassword')
      },
      mainClickhouse: {
        AdminPassword: requireSecret('MainMainClickhouseAdminPassword'),
        ClientPassword: requireSecret('MainMainClickhouseClientPassword')
      }
    }
  }
};
