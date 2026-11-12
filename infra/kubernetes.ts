import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { awsAccountId, isProduction } from './dns.ts';
import { defaultAwsRegion } from './aws.ts';

export const outputs: Record<string, pulumi.Output<string>> = {};

// NOTE: the Argo CD plugin reads production's stack outputs with this read-only user.
if (isProduction) {
  const argocdUser = new aws.iam.User('ArgocdCmpUser', {
    name: 'argo-cmp'
  });

  const argocdAccessKey = new aws.iam.AccessKey('ArgocdCmpAccessKey', {
    user: argocdUser.name
  });

  new aws.iam.UserPolicy('ArgocdCmpPolicy', {
    user: argocdUser.name,
    policy: pulumi.jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['ssm:GetParameter'],
          Resource: [
            `arn:aws:ssm:${defaultAwsRegion}:${awsAccountId}:parameter/pulumi/r2-state-read-credentials`
          ]
        },
        {
          Effect: 'Allow',
          Action: ['kms:Decrypt'],
          Resource: [aws.kms.getAliasOutput({ name: 'alias/pulumi-production' }).targetKeyArn]
        }
      ]
    })
  });

  outputs.KubernetesArgocdAccessKeyId = argocdAccessKey.id;
  outputs.KubernetesArgocdSecretAccessKey = argocdAccessKey.secret;
}
