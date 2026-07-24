import { usWest2Provider } from './aws';
import { cloudflareAccountId } from './dns';
import { STAGE_NAME } from './utils';

export const backupBucket = new sst.cloudflare.Bucket('BackupBucket', {
  transform: {
    bucket: {
      name: `${STAGE_NAME}-backups`,
      accountId: cloudflareAccountId,
      jurisdiction: 'default',
      location: 'wnam',
      storageClass: 'Standard'
    }
  }
});

export const s3Endpoint = `${cloudflareAccountId}.r2.cloudflarestorage.com`;

export const runnerCacheBucket = new sst.aws.Bucket(
  'RunnerCacheStore',
  {
    lifecycle: [{ id: 'expire-stale-cache', enabled: true, prefix: 'cache/', expiresIn: '30 days' }]
  },
  { provider: usWest2Provider }
);

export const runnerArtifactsBucket = new sst.aws.Bucket(
  'RunnerArtifactsStore',
  {
    transform: {
      lifecycle: {
        rules: [
          {
            id: 'tier-and-expire-builds',
            status: 'Enabled',
            transitions: [
              { days: 30, storageClass: 'STANDARD_IA' },
              { days: 90, storageClass: 'GLACIER_IR' }
            ],
            expiration: { days: 365 }
          },
          {
            id: 'abort-stuck-uploads',
            status: 'Enabled',
            abortIncompleteMultipartUpload: { daysAfterInitiation: 1 }
          }
        ]
      }
    }
  },
  { provider: usWest2Provider }
);
