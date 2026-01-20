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
