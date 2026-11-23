import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';

const stack = pulumi.getStack();
export const isProduction = stack === 'production';
export const isDev = stack === 'dev';
export const isCoreStack = isProduction || isDev;

export const STAGE_NAME = isProduction ? 'prod' : stack;

export const domain = isProduction ? 'pandoks.com' : `${STAGE_NAME}.pandoks.com`;

export const EXAMPLE_DOMAIN = 'example.pandoks.com';

// NOTE: not *.dev.pandoks.com, since Cloudflare's free edge certificate covers only one subdomain level
export const MOBILE_UPDATES_DOMAIN = isProduction
  ? 'mobile-updates.pandoks.com'
  : `mobile-updates-${STAGE_NAME}.pandoks.com`;
export const MOBILE_UPDATES_ASSETS_DOMAIN = isProduction
  ? 'mobile-updates-assets.pandoks.com'
  : `mobile-updates-assets-${STAGE_NAME}.pandoks.com`;

const awsAccountIdentityJson = await aws.getCallerIdentity();
export const awsAccountId = awsAccountIdentityJson.accountId;

const cloudflareZone = await cloudflare.getZone({ filter: { name: 'pandoks.com' } });
export const cloudflareAccountId = cloudflareZone.account.id;
export const cloudflareZoneId = cloudflareZone.id;

export const outputs = { StageName: STAGE_NAME, CloudflareAccountId: cloudflareAccountId };
