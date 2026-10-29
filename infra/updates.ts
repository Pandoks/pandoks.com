import { STAGE_NAME, cloudflareAccountId, domain } from './dns';
import { secrets } from './secrets';

const updatesBucket = new sst.cloudflare.Bucket('UpdatesBucket', {
  transform: {
    bucket: {
      name: `${STAGE_NAME}-updates`,
      accountId: cloudflareAccountId,
      jurisdiction: 'default',
      location: 'wnam',
      storageClass: 'Standard'
    }
  }
});

new sst.cloudflare.Worker('Updates', {
  accountId: cloudflareAccountId,
  handler: 'apps/updates/src/index.ts',
  domain: `updates.${domain}`,
  compatibility: { date: '2026-07-30' },
  link: [updatesBucket, secrets.updates.SigningKey]
});
