import { execSync } from 'node:child_process';
import { NON_PRODUCTION_CLUSTER_CONFIG, PRODUCTION_CLUSTER_CONFIG } from './cluster/config';
import { clusterTokenSecretName } from './cluster/topology';

const clusterNames = new Set(
  [...PRODUCTION_CLUSTER_CONFIG.clusters, ...NON_PRODUCTION_CLUSTER_CONFIG.clusters].map(
    ({ name }) => name
  )
);

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
  ovh: {
    ApplicationSecret: new sst.Secret('OvhApplicationSecret', process.env.OVH_APPLICATION_SECRET),
    ConsumerKey: new sst.Secret('OvhConsumerKey', process.env.OVH_CONSUMER_KEY),
    K3sTokens: Object.fromEntries(
      [...clusterNames].map((name) => [
        name,
        new sst.Secret(clusterTokenSecretName(name), 'Placeholder')
      ])
    ) as Record<string, sst.Secret>
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
