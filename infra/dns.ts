import { secrets, setSecret } from './secrets';
import { STAGE_NAME } from './utils';

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

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
const cloudflareIpResponse = (await cloudflareIpRequest.json()) as {
  result: { ipv4_cidrs: string[] };
  success: boolean;
};
if (!cloudflareIpResponse.success) throw new Error('Unable to load Cloudflare IP ranges');
export const cloudflareIpv4Cidrs = cloudflareIpResponse.result.ipv4_cidrs;
