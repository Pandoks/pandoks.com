import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { awsAccountId, isProduction } from './dns.ts';
import { defaultAwsRegion } from './aws.ts';

const STATE_BUCKET = 'sst-state-vccamowamddd';
const PRODUCTION_STACK_PATH = 'pulumi/.pulumi/stacks/personal/production.json';

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
            `arn:aws:ssm:${defaultAwsRegion}:${awsAccountId}:parameter/sst/passphrase/personal/production`
          ]
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: [
            `arn:aws:s3:::${STATE_BUCKET}/pulumi/.pulumi/meta.yaml`,
            `arn:aws:s3:::${STATE_BUCKET}/${PRODUCTION_STACK_PATH}*`
          ]
        },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: [`arn:aws:s3:::${STATE_BUCKET}`],
          Condition: { StringLike: { 's3:prefix': [`${PRODUCTION_STACK_PATH}*`] } }
        }
      ]
    })
  });

  outputs.KubernetesArgocdAccessKeyId = argocdAccessKey.id;
  outputs.KubernetesArgocdSecretAccessKey = argocdAccessKey.secret;
}
