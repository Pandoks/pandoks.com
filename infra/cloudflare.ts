import { EXAMPLE_DOMAIN, STAGE_NAME } from './dns';
import { secrets } from './secrets';
import { publicLoadBalancers } from './vps/vps';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps: {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
} = await cloudflareIpRequest.json();

if (publicLoadBalancers.length && $app.stage !== 'production') {
  for (const [i, loadBalancer] of publicLoadBalancers.entries()) {
    new cloudflare.DnsRecord(`ExampleDomainLoadBalancer${i}Ipv4`, {
      name: EXAMPLE_DOMAIN,
      zoneId: secrets.cloudflare.ZoneId.value,
      type: 'A',
      proxied: true,
      ttl: 1,
      comment: 'hetzner k3s',
      content: loadBalancer.ipv4
    });
    new cloudflare.DnsRecord(`ExampleDomainLoadBalancer${i}Ipv6`, {
      name: EXAMPLE_DOMAIN,
      zoneId: secrets.cloudflare.ZoneId.value,
      type: 'AAAA',
      proxied: true,
      ttl: 1,
      comment: 'hetzner k3s',
      content: loadBalancer.ipv6
    });
  }
}

export const backupBucket = new cloudflare.R2Bucket('BackupBucket', {
  name: `${STAGE_NAME}-backups`,
  accountId: secrets.cloudflare.AccountId.value,
  jurisdiction: 'default',
  location: 'wnam',
  storageClass: 'Standard'
});
