import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EXAMPLE_DOMAIN, STAGE_NAME, cloudflareZoneId } from './dns';
import { controlPlaneLoadBalancers, workerLoadBalancers } from './vps/vps';
import { secrets } from './secrets';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps: {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
} = await cloudflareIpRequest.json();

const publicLoadBalancers = [...workerLoadBalancers, ...controlPlaneLoadBalancers];

if (publicLoadBalancers.length && $app.stage !== 'production') {
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

const openSslConfigPath = resolve('infra/vps/vps.openssl.conf');
const certificateSigningRequestPath = resolve(`infra/vps/vps.origin.${STAGE_NAME}.csr`);
const certificateKeyPath = resolve(`infra/vps/vps.origin.${STAGE_NAME}.key`);

let needToSetCertificateSecret = false;
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
  needToSetCertificateSecret = true;
}

const certificateSigningRequest = readFileSync(certificateSigningRequestPath);
const hetznerOriginCert = new cloudflare.OriginCaCertificate(
  'HetznerOriginCloudflareCaCertificate',
  {
    hostnames: [EXAMPLE_DOMAIN],
    requestType: 'origin-rsa',
    csr: certificateSigningRequest.toString(),
    requestedValidity: 5475 // 15 years
  }
);

if (needToSetCertificateSecret) {
  $resolve([hetznerOriginCert.certificate, secrets.k8s.HetznerOriginTlsCrt.name]).apply(
    ([certificate, secretName]) => {
      execFileSync(
        '/bin/sh',
        ['-lc', `sst secret set ${secretName} --stage ${$app.stage} <<'EOF'\n${certificate}EOF`],
        { stdio: 'inherit' }
      );
    }
  );
}
