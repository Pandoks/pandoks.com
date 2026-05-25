import { cloudflareAccountId, STAGE_NAME } from './dns';

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

export const builderCacheBucket = new sst.aws.Bucket('BuilderCacheBucket', {
  lifecycle: [{ id: 'expire-stale-cache', enabled: true, prefix: 'cache/', expiresIn: '30 days' }]
});

export const builderArtifactsBucket = new sst.aws.Bucket('BuilderArtifactsBucket', {
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
});
