import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import { usWest2Provider } from './aws.ts';
import { cloudflareAccountId, isProduction, STAGE_NAME } from './dns.ts';

export const backupBucket = new cloudflare.R2Bucket(
  'BackupBucket',
  {
    name: `${STAGE_NAME}-backups`,
    accountId: cloudflareAccountId,
    jurisdiction: 'default',
    location: 'wnam',
    storageClass: 'Standard'
  },
  { protect: isProduction, retainOnDelete: isProduction }
);

export const s3Endpoint = `${cloudflareAccountId}.r2.cloudflarestorage.com`;

function createRunnerBucket({
  id,
  name,
  lifecycleRules
}: {
  id: string;
  name: string;
  lifecycleRules: aws.types.input.s3.BucketLifecycleConfigurationRule[];
}) {
  const bucket = new aws.s3.Bucket(
    id,
    { bucket: `pandoks-${STAGE_NAME}-${name}`, forceDestroy: true },
    { provider: usWest2Provider, protect: isProduction, retainOnDelete: isProduction }
  );
  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
    `${id}PublicAccessBlock`,
    {
      bucket: bucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true
    },
    { provider: usWest2Provider }
  );
  const policy = new aws.s3.BucketPolicy(
    `${id}Policy`,
    {
      bucket: bucket.bucket,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Deny',
            Action: 's3:*',
            Resource: [pulumi.interpolate`${bucket.arn}/*`, bucket.arn],
            Principal: '*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } }
          }
        ]
      })
    },
    { provider: usWest2Provider, dependsOn: publicAccessBlock }
  );
  new aws.s3.BucketLifecycleConfiguration(
    `${id}Lifecycle`,
    { bucket: bucket.bucket, rules: lifecycleRules },
    { provider: usWest2Provider, dependsOn: policy }
  );
  return bucket;
}

export const runnerCacheBucket = createRunnerBucket({
  id: 'RunnerCacheStore',
  name: 'runner-cache',
  lifecycleRules: [
    {
      id: 'expire-stale-cache',
      status: 'Enabled',
      filter: { prefix: 'cache/' },
      expiration: { days: 30 }
    }
  ]
});

export const runnerArtifactsBucket = createRunnerBucket({
  id: 'RunnerArtifactsStore',
  name: 'runner-artifacts',
  lifecycleRules: [
    {
      id: 'tier-and-expire-builds',
      status: 'Enabled',
      filter: {},
      transitions: [
        { days: 30, storageClass: 'STANDARD_IA' },
        { days: 90, storageClass: 'GLACIER_IR' }
      ],
      expiration: { days: 365 }
    },
    {
      id: 'abort-stuck-uploads',
      status: 'Enabled',
      filter: {},
      abortIncompleteMultipartUpload: { daysAfterInitiation: 1 }
    }
  ]
});
