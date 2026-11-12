import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import * as github from '@pulumi/github';
import * as hcloud from '@pulumi/hcloud';
import * as tailscale from '@pulumi/tailscale';

// NOTE: keyed by name, so `pnpm cluster deploy` and Argo substitute them as `${Name}`.
export const outputs: Record<string, pulumi.Output<string>> = {};

function requireSecret(name: string) {
  // NOTE: invoke results aren't secret, so without this the values print and land in state as-is.
  const value = pulumi.secret(
    aws.ssm.getParameterOutput({
      name: `/pulumi/${pulumi.getStack()}/${name}`,
      withDecryption: true
    }).value
  );
  outputs[name] = value;
  return value;
}

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

// NOTE: explicit, so no stack picks up ambient credentials; Pulumi.yaml disables the defaults.
export const providers = {
  cloudflare: new cloudflare.Provider('Cloudflare', { apiToken: secrets.cloudflare.ApiKey }),
  github: new github.Provider('Github', { token: secrets.github.PersonalAccessToken }),
  hcloud: new hcloud.Provider('Hetzner', { token: secrets.hetzner.ApiKey }),
  tailscale: new tailscale.Provider('Tailscale', {
    oauthClientId: secrets.tailscale.OauthClientId,
    oauthClientSecret: secrets.tailscale.OauthClientSecret
  })
};
