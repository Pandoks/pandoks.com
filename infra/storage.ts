import { STAGE_NAME } from './dns';
import { secrets } from './secrets';

export const backupBucket = new cloudflare.R2Bucket('BackupBucket', {
  name: `${STAGE_NAME}-backups`,
  accountId: secrets.cloudflare.AccountId.value,
  jurisdiction: 'default',
  location: 'wnam',
  storageClass: 'Standard'
});

export const s3Endpoint = $interpolate`${secrets.cloudflare.AccountId.value}.r2.cloudflarestorage.com`;
