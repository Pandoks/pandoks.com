import { awsAccountId, isProduction, isDev } from './dns';
import { defaultAwsRegion } from './aws';
import { secrets, setSecret } from './secrets';

if (isProduction || isDev) {
  const argocdUser = new aws.iam.User('ArgocdCmpUser', {
    name: isProduction ? 'argo-cmp' : 'argo-cmp-preview'
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
            `arn:aws:ssm:${defaultAwsRegion}:${awsAccountId}:parameter/sst/bootstrap`,
            `arn:aws:ssm:${defaultAwsRegion}:${awsAccountId}:parameter/sst/passphrase/personal/${$app.stage}`
          ]
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: [
            `arn:aws:s3:::sst-state-*/app/personal/${$app.stage}.json`,
            `arn:aws:s3:::sst-state-*/passphrase/personal/${$app.stage}`
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
