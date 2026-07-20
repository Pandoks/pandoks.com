import { cloudflareZoneId } from './dns';
import { publicIngressLoadBalancers } from './cluster/cluster';
import { EXAMPLE_DOMAIN, isProduction } from './utils';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps = (await cloudflareIpRequest.json()) as {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
};

if (publicIngressLoadBalancers.length && !isProduction) {
  // NOTE: no AAAA records because openstack floating ips are ipv4 only
  for (const [i, loadBalancer] of publicIngressLoadBalancers.entries()) {
    new cloudflare.DnsRecord(`ExampleDomainLoadBalancer${i}Ipv4`, {
      name: EXAMPLE_DOMAIN,
      zoneId: cloudflareZoneId,
      type: 'A',
      proxied: true,
      ttl: 1,
      comment: 'ovh k3s',
      content: loadBalancer.floatingIp.apply((floatingIp) => floatingIp.ip)
    });
  }
}
