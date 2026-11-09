import { secrets, setSecret } from './secrets';

export const isProduction = $app.stage === 'production';
export const isSharedDev = $app.stage === 'dev';
if ($app.stage === 'prod') {
  throw new Error("Stage 'prod' would reuse production's names; deploy 'production' instead");
}

export const STAGE_NAME = isProduction ? 'prod' : $app.stage;

export const domain = isProduction
  ? 'pandoks.com'
  : isSharedDev
    ? 'dev.pandoks.com'
    : `${STAGE_NAME}.dev.pandoks.com`;

export const EXAMPLE_DOMAIN = isProduction
  ? 'example.pandoks.com'
  : isSharedDev
    ? '*.pandoks.com'
    : `example-${STAGE_NAME}.pandoks.com`;

export const TAILSCALE_STAGE_TAG = isProduction ? 'tag:prod' : 'tag:dev';

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
