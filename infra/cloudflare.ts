import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as cloudflare from '@pulumi/cloudflare';
import { isProduction, STAGE_NAME } from '@pandoks.com/infra/stack';
import { EXAMPLE_DOMAIN, cloudflareZoneId } from './dns.ts';
import { controlPlaneLoadBalancers, workerLoadBalancers } from './vps/vps.ts';
import { createClusterSecret } from './kubernetes.ts';

const publicLoadBalancers = [...workerLoadBalancers, ...controlPlaneLoadBalancers];

if (publicLoadBalancers.length && !isProduction) {
  for (const [i, loadBalancer] of publicLoadBalancers.entries()) {
    new cloudflare.DnsRecord(`ExampleDomainLoadBalancer${i}Ipv4`, {
      name: EXAMPLE_DOMAIN,
      zoneId: cloudflareZoneId,
      type: 'A',
      proxied: true,
      ttl: 1,
      comment: 'hetzner k3s',
      content: loadBalancer.loadbalancer.ipv4
    });
    new cloudflare.DnsRecord(`ExampleDomainLoadBalancer${i}Ipv6`, {
      name: EXAMPLE_DOMAIN,
      zoneId: cloudflareZoneId,
      type: 'AAAA',
      proxied: true,
      ttl: 1,
      comment: 'hetzner k3s',
      content: loadBalancer.loadbalancer.ipv6
    });
  }
}

// NOTE: a new stage or key needs a new CSR here and its key set as secret HetznerOriginTlsKey:
// openssl req -new -newkey rsa:2048 -nodes -keyout <key> \
//   -out infra/vps/vps.origin.<stage>.csr -config infra/vps/vps.openssl.conf
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
  }
);

createClusterSecret({ name: 'HetznerOriginTlsCrt', value: hetznerOriginCert.certificate });
