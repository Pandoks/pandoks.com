import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  EXAMPLE_DOMAIN,
  MOBILE_UPDATES_DOMAIN,
  STAGE_NAME,
  cloudflareZoneId,
  isProduction
} from './dns';
import { controlPlaneLoadBalancers, workerLoadBalancers } from './vps/vps';
import { secrets } from './secrets';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps = (await cloudflareIpRequest.json()) as {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
};

const publicLoadBalancers = [...workerLoadBalancers, ...controlPlaneLoadBalancers];

if (!isProduction) {
  createLoadBalancerRecords({ name: 'ExampleDomain', domain: EXAMPLE_DOMAIN });
}
createLoadBalancerRecords({ name: 'MobileUpdatesDomain', domain: MOBILE_UPDATES_DOMAIN });

new sst.Linkable('MobileUpdatesDomain', { properties: { value: MOBILE_UPDATES_DOMAIN } });

function createLoadBalancerRecords({ name, domain }: { name: string; domain: string }) {
  for (const [i, loadBalancer] of publicLoadBalancers.entries()) {
    new cloudflare.DnsRecord(`${name}LoadBalancer${i}Ipv4`, {
      name: domain,
      zoneId: cloudflareZoneId,
      type: 'A',
      proxied: true,
      ttl: 1,
      comment: 'hetzner k3s',
      content: loadBalancer.loadbalancer.ipv4
    });
    new cloudflare.DnsRecord(`${name}LoadBalancer${i}Ipv6`, {
      name: domain,
      zoneId: cloudflareZoneId,
      type: 'AAAA',
      proxied: true,
      ttl: 1,
      comment: 'hetzner k3s',
      content: loadBalancer.loadbalancer.ipv6
    });
  }
}

const openSslConfigPath = resolve('infra/vps/vps.openssl.conf');
const certificateSigningRequestPath = resolve(`infra/vps/vps.origin.${STAGE_NAME}.csr`);
const certificateKeyPath = resolve(`infra/vps/vps.origin.${STAGE_NAME}.key`);

if (!existsSync(certificateSigningRequestPath)) {
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      certificateKeyPath,
      '-out',
      certificateSigningRequestPath,
      '-config',
      openSslConfigPath
    ],
    { stdio: 'inherit' }
  );
  secrets.k8s.HetznerOriginTlsKey.name.apply((secretName) => {
    execFileSync(
      '/bin/sh',
      ['-lc', `sst secret set ${secretName} --stage ${$app.stage} < ${certificateKeyPath}`],
      { stdio: 'inherit' }
    );
  });
}

const certificateSigningRequest = readFileSync(certificateSigningRequestPath);
const hetznerOriginCert = new cloudflare.OriginCaCertificate(
  'HetznerOriginCloudflareCaCertificate',
  {
    hostnames: [EXAMPLE_DOMAIN, MOBILE_UPDATES_DOMAIN],
    requestType: 'origin-rsa',
    csr: certificateSigningRequest.toString(),
    requestedValidity: 5475 // 15 years
  }
);

// NOTE: changing hostnames reissues the certificate, so keep the ingress's copy in sync
$resolve([
  hetznerOriginCert.certificate,
  secrets.k8s.HetznerOriginTlsCrt.name,
  secrets.k8s.HetznerOriginTlsCrt.value
]).apply(([certificate, secretName, currentCertificate]) => {
  if (certificate.trim() === currentCertificate.trim()) return;
  execFileSync(
    '/bin/sh',
    ['-lc', `sst secret set ${secretName} --stage ${$app.stage} <<'EOF'\n${certificate}EOF`],
    { stdio: 'inherit' }
  );
});
