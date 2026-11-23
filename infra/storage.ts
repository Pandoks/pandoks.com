import * as cloudflare from '@pulumi/cloudflare';
import { createBucket } from '@pandoks.com/infra/aws';
import { isProduction, STAGE_NAME } from '@pandoks.com/infra/stack';
import { usWest2Provider } from './aws.ts';
import { cloudflareAccountId } from './dns.ts';

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

const runnerBucketOptions = {
  provider: usWest2Provider,
  protect: isProduction,
  retainOnDelete: isProduction
};

export const runnerCacheBucket = createBucket({
  id: 'RunnerCacheStore',
  name: `pandoks-${STAGE_NAME}-runner-cache`,
  forceDestroy: true,
  lifecycleRules: [
    {
      id: 'expire-stale-cache',
      status: 'Enabled',
      filter: { prefix: 'cache/' },
      expiration: { days: 30 }
    }
  ],
  options: runnerBucketOptions
});

export const runnerArtifactsBucket = createBucket({
  id: 'RunnerArtifactsStore',
  name: `pandoks-${STAGE_NAME}-runner-artifacts`,
  forceDestroy: true,
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
  ],
  options: runnerBucketOptions
});

export const outputs = { BackupBucket: backupBucket.name };
