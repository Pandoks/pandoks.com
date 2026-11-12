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

function createRunnerBucket({ id, name }: { id: string; name: string }) {
  const bucket = new aws.s3.Bucket(
    id,
    { bucket: `pandoks-${STAGE_NAME}-${name}`, forceDestroy: true },
    { provider: usWest2Provider, protect: isProduction, retainOnDelete: isProduction }
  );
  new aws.s3.BucketPublicAccessBlock(
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
  new aws.s3.BucketPolicy(
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
    { provider: usWest2Provider }
  );
  return bucket;
}

export const runnerCacheBucket = createRunnerBucket({
  id: 'RunnerCacheStore',
  name: 'runner-cache'
});
new aws.s3.BucketLifecycleConfiguration(
  'RunnerCacheStoreLifecycle',
  {
    bucket: runnerCacheBucket.bucket,
    rules: [
      {
        id: 'expire-stale-cache',
        status: 'Enabled',
        filter: { prefix: 'cache/' },
        expiration: { days: 30 }
      }
    ]
  },
  { provider: usWest2Provider }
);

export const runnerArtifactsBucket = createRunnerBucket({
  id: 'RunnerArtifactsStore',
  name: 'runner-artifacts'
});

export const outputs = { BackupBucket: backupBucket.name };
