import { cloudflareAccountId, cloudflareZoneId } from './dns';
import { publicIngress } from './cluster/cluster';
import { EXAMPLE_DOMAIN, isProduction } from './utils';

if (publicIngress && !isProduction) {
  if (publicIngress.mode === 'cloudflare') {
    const monitor = new cloudflare.LoadBalancerMonitor('ExampleDomainIngressMonitor', {
      accountId: cloudflareAccountId,
      type: 'https',
      path: '/',
      expectedCodes: '2xx',
      followRedirects: true,
      header: { Host: [EXAMPLE_DOMAIN] }
    });
    const pool = new cloudflare.LoadBalancerPool('ExampleDomainIngressPool', {
      accountId: cloudflareAccountId,
      name: `${$app.stage}-ovh-ingress`,
      minimumOrigins: 1,
      monitor: monitor.id,
      originSteering: { policy: 'random' },
      origins: publicIngress.origins.map((origin, index) => ({
        name: `ovh-ingress-${index}`,
        address: origin.address,
        port: 443,
        enabled: true,
        weight: 1,
        header: { hosts: [EXAMPLE_DOMAIN] }
      }))
    });
    new cloudflare.LoadBalancer('ExampleDomainCloudflareLoadBalancer', {
      zoneId: cloudflareZoneId,
      name: EXAMPLE_DOMAIN,
      defaultPools: [pool.id],
      fallbackPool: pool.id,
      proxied: true
    });
  } else {
    // No AAAA record because OVH public addresses are IPv4.
    new cloudflare.DnsRecord('ExampleDomainLoadBalancerIpv4', {
      name: EXAMPLE_DOMAIN,
      zoneId: cloudflareZoneId,
      type: 'A',
      proxied: true,
      ttl: 1,
      comment: 'ovh k3s',
      content: publicIngress.origins[0].address
    });
  }
}
