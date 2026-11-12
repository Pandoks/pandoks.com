import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as cloudflare from '@pulumi/cloudflare';
import { EXAMPLE_DOMAIN, STAGE_NAME, cloudflareZoneId, isProduction } from './dns.ts';
import { controlPlaneLoadBalancers, workerLoadBalancers } from './vps/vps.ts';
import { providers } from './secrets.ts';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps = (await cloudflareIpRequest.json()) as {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
};

const publicLoadBalancers = [...workerLoadBalancers, ...controlPlaneLoadBalancers];

if (publicLoadBalancers.length && !isProduction) {
  for (const [i, loadBalancer] of publicLoadBalancers.entries()) {
    new cloudflare.DnsRecord(
      `ExampleDomainLoadBalancer${i}Ipv4`,
      {
        name: EXAMPLE_DOMAIN,
        zoneId: cloudflareZoneId,
        type: 'A',
        proxied: true,
        ttl: 1,
        comment: 'hetzner k3s',
        content: loadBalancer.loadbalancer.ipv4
      },
      { provider: providers.cloudflare }
    );
    new cloudflare.DnsRecord(
      `ExampleDomainLoadBalancer${i}Ipv6`,
      {
        name: EXAMPLE_DOMAIN,
        zoneId: cloudflareZoneId,
        type: 'AAAA',
        proxied: true,
        ttl: 1,
        comment: 'hetzner k3s',
        content: loadBalancer.loadbalancer.ipv6
      },
      { provider: providers.cloudflare }
    );
  }
}

const certificateSigningRequest = readFileSync(
  join(import.meta.dirname, `vps/vps.origin.${STAGE_NAME}.csr`),
  'utf8'
);
const hetznerOriginCert = new cloudflare.OriginCaCertificate(
  'HetznerOriginCloudflareCaCertificate',
  {
    hostnames: [EXAMPLE_DOMAIN],
    requestType: 'origin-rsa',
    csr: certificateSigningRequest,
    requestedValidity: 5475 // 15 years
  },
  { provider: providers.cloudflare }
);

export const outputs = { HetznerOriginTlsCrt: hetznerOriginCert.certificate };
