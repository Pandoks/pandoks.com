import { spawnSync } from 'node:child_process';

export const secrets = {
  Stage: new sst.Secret('StageName', 'dev'), // Automatically set during deploy
  notion: {
    ApiKey: new sst.Secret('NotionApiKey'),
    WebhookVerificationToken: new sst.Secret('NotionWebhookVerificationToken')
  },
  aws: {
    Region: new sst.Secret('AwsRegion', 'us-west-1')
  },
  apple: {
    PushNotificationApnsKey: new sst.Secret('ApplePushNotificationApnsKey', 'Placeholder'),
    PushNotificationKeyId: new sst.Secret('ApplePushNotificationKeyId', 'B2MH5U84TX'),
    PushNotificationTeamId: new sst.Secret('ApplePushNotificationTeamId', '36PW35T7W5')
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
  push: {
    QueueUrl: new sst.Secret('PushQueueUrl', 'Placeholder'), // Automatically set during deploy
    AwsAccessKeyId: new sst.Secret('PushWorkerAwsAccessKeyId', 'Placeholder'), // Automatically set during deploy
    AwsSecretAccessKey: new sst.Secret('PushWorkerAwsSecretAccessKey', 'Placeholder'), // Automatically set during deploy
    FirebaseProjectId: new sst.Secret('FirebaseProjectId', 'Placeholder'), // Automatically set during deploy
    FirebaseServiceAccountJson: new sst.Secret('FirebaseServiceAccountJson', 'Placeholder'), // Automatically set during deploy
    FirebaseGoogleServicesJson: new sst.Secret('FirebaseGoogleServicesJson', 'Placeholder') // Automatically set during deploy
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
  tailscale: {
    ApiKey: new sst.Secret('TailscaleApiKey')
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
    const result = spawnSync('sst', ['secret', 'set', name, value, '--stage', $app.stage], {
      stdio: 'inherit'
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`sst secret set ${name} exited with status ${result.status}`);
    }
  });
}
