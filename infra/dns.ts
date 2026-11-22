import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import { isProduction, STAGE_NAME } from '@pandoks.com/infra/stack';

export const domain = isProduction ? 'pandoks.com' : 'dev.pandoks.com';

export const EXAMPLE_DOMAIN = 'example.pandoks.com';

const awsAccountIdentityJson = await aws.getCallerIdentity();
export const awsAccountId = awsAccountIdentityJson.accountId;

const cloudflareZone = await cloudflare.getZone({ filter: { name: 'pandoks.com' } });
export const cloudflareAccountId = cloudflareZone.account.id;
export const cloudflareZoneId = cloudflareZone.id;

export const outputs = { StageName: STAGE_NAME };
