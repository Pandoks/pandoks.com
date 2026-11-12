import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import { usWest2Provider } from './aws.ts';
import { cloudflareAccountId, STAGE_NAME } from './dns.ts';

// NOTE: aliases adopt resources SST created inside its bucket components.
export const backupBucket = new cloudflare.R2Bucket(
  'BackupBucket',
  {
    name: `${STAGE_NAME}-backups`,
    accountId: cloudflareAccountId,
    jurisdiction: 'default',
    location: 'wnam',
    storageClass: 'Standard'
  },
  {
    aliases: [
      {
        name: 'BackupBucketBucket',
        parent: pulumi.createUrn('BackupBucket', 'sst:cloudflare:Bucket')
      }
    ]
  }
);

export const s3Endpoint = `${cloudflareAccountId}.r2.cloudflarestorage.com`;

function createRunnerBucket({ name }: { name: string }) {
  const sstBucketUrn = pulumi.createUrn(name, 'sst:aws:Bucket');
  const bucket = new aws.s3.Bucket(
    name,
    { forceDestroy: true },
    {
      provider: usWest2Provider,
      aliases: [{ name: `${name}Bucket`, parent: sstBucketUrn }],
      // NOTE: keeps the random name SST gave existing buckets; new stacks get a Pulumi autoname.
      ignoreChanges: ['bucket']
    }
  );
  new aws.s3.BucketPublicAccessBlock(
    `${name}PublicAccessBlock`,
    {
      bucket: bucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true
    },
    { provider: usWest2Provider, aliases: [{ parent: sstBucketUrn }] }
  );
  new aws.s3.BucketPolicy(
    `${name}Policy`,
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
    { provider: usWest2Provider, aliases: [{ parent: sstBucketUrn }] }
  );
  return { bucket, sstBucketUrn };
}

const runnerCacheStore = createRunnerBucket({ name: 'RunnerCacheStore' });
new aws.s3.BucketLifecycleConfiguration(
  'RunnerCacheStoreLifecycle',
  {
    bucket: runnerCacheStore.bucket.bucket,
    rules: [
      {
        id: 'expire-stale-cache',
        status: 'Enabled',
        filter: { prefix: 'cache/' },
        expiration: { days: 30 }
      }
    ]
  },
  { provider: usWest2Provider, aliases: [{ parent: runnerCacheStore.sstBucketUrn }] }
);
export const runnerCacheBucket = runnerCacheStore.bucket;

export const runnerArtifactsBucket = createRunnerBucket({ name: 'RunnerArtifactsStore' }).bucket;

export const outputs = { BackupBucket: backupBucket.name };
