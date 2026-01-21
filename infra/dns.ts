import { secrets, setSecret } from './secrets';

export const isProduction = $app.stage === 'production';

export const domain = isProduction ? 'pandoks.com' : 'dev.pandoks.com';

export const EXAMPLE_DOMAIN = 'example.pandoks.com';

export const STAGE_NAME = isProduction ? 'prod' : 'dev';

secrets.Stage.value.apply((stageName) => {
  if (stageName !== STAGE_NAME) {
    setSecret(secrets.Stage.name, STAGE_NAME);
  }
});

const awsAccountIdentityJson = await aws.getCallerIdentity();
export const awsAccountId = awsAccountIdentityJson.accountId;

const awsRegionJson = await aws.getRegion();
export const awsRegion = awsRegionJson.name;
secrets.aws.Region.value.apply((region) => {
  if (region !== awsRegion) {
    setSecret(secrets.aws.Region.name, awsRegion);
  }
});

const cloudflareZone = await cloudflare.getZone({ filter: { name: 'pandoks.com' } });
export const cloudflareAccountId = cloudflareZone.account.id;
export const cloudflareZoneId = cloudflareZone.id;
