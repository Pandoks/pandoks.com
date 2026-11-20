import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { awsAccountId, isProduction, STAGE_NAME } from './dns.ts';
import { defaultAwsRegion } from './aws.ts';
import { secrets } from './secrets.ts';
import { kubernetesOperatorOauthClient } from './tailscale.ts';

const KMS_ALIAS = isProduction ? 'alias/pulumi-production' : 'alias/pulumi-nonproduction';

const clusterSecretParameterArnPattern = `arn:aws:ssm:${defaultAwsRegion}:${awsAccountId}:parameter/kubernetes/${STAGE_NAME}/*`;

// NOTE: ExternalSecrets read each one by name (`remoteRef.key`) through External Secrets Operator.
export function createClusterSecret({
  name,
  value
}: {
  name: string;
  value: pulumi.Input<string>;
}) {
  return new aws.ssm.Parameter(`ClusterSecret${name}`, {
    name: `/kubernetes/${STAGE_NAME}/${name}`,
    type: 'SecureString',
    keyId: KMS_ALIAS,
    value
  });
}

for (const [name, value] of Object.entries({
  KubernetesGrafanaAdminPassword: secrets.k8s.grafana.AdminPassword,
  KubernetesTailscaleOauthClientId: kubernetesOperatorOauthClient.id,
  KubernetesTailscaleOauthClientSecret: kubernetesOperatorOauthClient.key,
  HetznerOriginTlsKey: secrets.k8s.HetznerOriginTlsKey,
  CloudflareBackupAccessKey: secrets.cloudflare.BackupAccessKey,
  CloudflareBackupSecretKey: secrets.cloudflare.BackupSecretKey,
  MainMainPostgresSuperuserPassword: secrets.k8s.main.mainPostgres.SuperuserPassword,
  MainMainPostgresAdminPassword: secrets.k8s.main.mainPostgres.AdminPassword,
  MainMainPostgresClientPassword: secrets.k8s.main.mainPostgres.ClientPassword,
  MainMainPostgresReplicationPassword: secrets.k8s.main.mainPostgres.ReplicationPassword,
  MainMainPostgresPatroniPassword: secrets.k8s.main.mainPostgres.PatroniPassword,
  MainMainValkeyAdminPassword: secrets.k8s.main.mainValkey.AdminPassword,
  MainMainValkeyClientPassword: secrets.k8s.main.mainValkey.ClientPassword,
  MainMainClickhouseAdminPassword: secrets.k8s.main.mainClickhouse.AdminPassword,
  MainMainClickhouseClientPassword: secrets.k8s.main.mainClickhouse.ClientPassword
})) {
  createClusterSecret({ name, value });
}

const externalSecretsUser = new aws.iam.User('ExternalSecretsUser', {
  name: `external-secrets-${pulumi.getStack()}`
});

export const externalSecretsAccessKey = new aws.iam.AccessKey('ExternalSecretsAccessKey', {
  user: externalSecretsUser.name
});

new aws.iam.UserPolicy('ExternalSecretsPolicy', {
  user: externalSecretsUser.name,
  policy: pulumi.jsonStringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ssm:GetParameter'],
        Resource: [clusterSecretParameterArnPattern]
      },
      {
        Effect: 'Allow',
        Action: ['kms:Decrypt'],
        Resource: [aws.kms.getAliasOutput({ name: KMS_ALIAS }).targetKeyArn],
        Condition: {
          StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': clusterSecretParameterArnPattern }
        }
      }
    ]
  })
});

// NOTE: deploy-infra.yaml syncs these to prod (k3s/README.md#rotating-the-external-secrets-access-key)
export const outputs = {
  ExternalSecretsAccessKeyId: externalSecretsAccessKey.id,
  ExternalSecretsSecretAccessKey: externalSecretsAccessKey.secret
};
