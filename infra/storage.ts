import { STAGE_NAME, cloudflareAccountId } from './dns';

export const backupBucket = new cloudflare.R2Bucket('BackupBucket', {
  name: `${STAGE_NAME}-backups`,
  accountId: cloudflareAccountId,
  jurisdiction: 'default',
  location: 'wnam',
  storageClass: 'Standard'
});

export const s3Endpoint = `${cloudflareAccountId}.r2.cloudflarestorage.com`;
