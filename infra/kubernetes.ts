import { awsAccountId, awsRegion, isProduction } from './dns';
import { secrets, setSecret } from './secrets';

if (isProduction) {
  const argocdUser = new aws.iam.User('ArgocdCmpUser', {
    name: 'argo-cmp'
  });

  const argocdAccessKey = new aws.iam.AccessKey('ArgocdCmpAccessKey', {
    user: argocdUser.name
  });

  new aws.iam.UserPolicy('ArgocdCmpPolicy', {
    user: argocdUser.name,
    policy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['ssm:GetParameter'],
          Resource: [
            `arn:aws:ssm:${awsRegion}:${awsAccountId}:parameter/sst/bootstrap`,
            `arn:aws:ssm:${awsRegion}:${awsAccountId}:parameter/sst/passphrase/personal/production`
          ]
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: [
            'arn:aws:s3:::sst-state-*/app/personal/production.json',
            'arn:aws:s3:::sst-state-*/passphrase/personal/production'
          ]
        }
      ]
    })
  });

  $resolve([
    secrets.k8s.argocd.AccessKeyId.value,
    argocdAccessKey.id,
    secrets.k8s.argocd.SecretAccessKey.value,
    argocdAccessKey.secret
  ]).apply(([secretAccessKeyId, argoAccessKeyId, secretAccessKeySecret, argoSecretAccessKey]) => {
    if (secretAccessKeyId !== argoAccessKeyId) {
      setSecret(secrets.k8s.argocd.AccessKeyId.name, argocdAccessKey.id);
    }
    if (secretAccessKeySecret !== argoSecretAccessKey) {
      setSecret(secrets.k8s.argocd.SecretAccessKey.name, argocdAccessKey.secret);
    }
  });
}

export {};
