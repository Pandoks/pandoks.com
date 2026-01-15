import { execSync } from 'node:child_process';

export const secrets = {
  Stage: new sst.Secret('StageName', 'dev'),
  notion: {
    ApiKey: new sst.Secret('NotionApiKey'),
    AuthToken: new sst.Secret('NotionAuthToken')
  },
  cloudflare: {
    ApiKey: new sst.Secret('CloudflareApiKey'),
    BackupAccessKey: new sst.Secret('CloudflareBackupAccessKey'),
    BackupSecretKey: new sst.Secret('CloudflareBackupSecretKey')
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
      OauthClientSecret: new sst.Secret('KubernetesTailscaleOauthClientSecret')
    },
    grafana: {
      AdminPassword: new sst.Secret('KubernetesGrafanaAdminPassword', 'password')
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
