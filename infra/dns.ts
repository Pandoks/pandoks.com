import { secrets, setSecret } from './secrets';

export const isProduction = $app.stage === 'production';

export const domain = isProduction ? 'pandoks.com' : 'dev.pandoks.com';

export const EXAMPLE_DOMAIN = 'example.pandoks.com';

// NOTE: not mobile-updates.dev.pandoks.com, since Cloudflare's free edge certificate covers only one subdomain level
export const MOBILE_UPDATES_DOMAIN = isProduction
  ? 'mobile-updates.pandoks.com'
  : 'mobile-updates-dev.pandoks.com';

export const STAGE_NAME = isProduction ? 'prod' : 'dev';

secrets.Stage.value.apply((stageName) => {
  if (stageName !== STAGE_NAME) {
    setSecret(secrets.Stage.name, STAGE_NAME);
  }
});

const awsAccountIdentityJson = await aws.getCallerIdentity();
export const awsAccountId = awsAccountIdentityJson.accountId;

const cloudflareZone = await cloudflare.getZone({ filter: { name: 'pandoks.com' } });
export const cloudflareAccountId = cloudflareZone.account.id;
export const cloudflareZoneId = cloudflareZone.id;
