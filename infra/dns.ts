import { secrets } from './secrets';
import { publicLoadBalancer } from './vps/vps';

export const domain = $app.stage === 'production' ? 'pandoks.com' : 'dev.pandoks.com';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps: {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
} = await cloudflareIpRequest.json();

if (publicLoadBalancer) {
  const EXAMPLE_DOMAIN = 'example.pandoks.com';
  new cloudflare.DnsRecord('ExampleDomainIpv4', {
    name: EXAMPLE_DOMAIN,
    zoneId: secrets.cloudflare.ZoneId.value,
    type: 'A',
    proxied: true,
    ttl: 1,
    comment: 'hetzner k3s',
    content: publicLoadBalancer.ipv4
  });
  new cloudflare.DnsRecord('ExampleDomainIpv6', {
    name: EXAMPLE_DOMAIN,
    zoneId: secrets.cloudflare.ZoneId.value,
    type: 'AAAA',
    proxied: true,
    ttl: 1,
    comment: 'hetzner k3s',
    content: publicLoadBalancer.ipv6
  });
}
