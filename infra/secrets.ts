import { execSync } from 'node:child_process';

export const secrets = {
  Stage: new sst.Secret('StageName', 'dev'),
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
    K3sToken: new sst.Secret('HetznerK3sToken')
  },
  tailscale: {
    ApiKey: new sst.Secret('TailscaleApiKey')
  },
  k8s: {
    tailscale: {
      OauthClientId: new sst.Secret('KubernetesTailscaleOauthClientId'),
      OauthClientSecret: new sst.Secret('KubernetesTailscaleOauthClientSecret'),
      Hostname: new sst.Secret('KubernetesTailscaleHostname')
    },
    etcd: {
      S3Endpoint: new sst.Secret('KubernetesEtcdS3Endpoint'),
      S3Bucket: new sst.Secret('KubernetesEtcdS3Bucket'),
      S3AccessKey: new sst.Secret('KubernetesEtcdS3AccessKey'),
      S3SecretKey: new sst.Secret('KubernetesEtcdS3SecretKey')
    },
    grafana: {
      AdminPassword: new sst.Secret('KubernetesGrafanaAdminPassword')
    },
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

export function setSecret(secretName: $util.Input<string>, secretValue: $util.Input<string>) {
  $resolve([secretName, secretValue]).apply(([name, value]) => {
    execSync(`sst secret set ${name} --stage ${$app.stage} ${value}`, {
      stdio: 'inherit'
    });
  });
}
