import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EXAMPLE_DOMAIN, STAGE_NAME, cloudflareZoneId, isProduction } from './dns';
import { publicIngressLoadBalancers } from './cluster/cluster';
import { secrets } from './secrets';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps = (await cloudflareIpRequest.json()) as {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
};

const publicLoadBalancers = publicIngressLoadBalancers;

if (publicLoadBalancers.length && !isProduction) {
  // NOTE: no AAAA records because openstack floating ips are ipv4 only
  for (const [i, loadBalancer] of publicLoadBalancers.entries()) {
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

const openSslConfigPath = resolve('infra/cluster/cluster.openssl.conf');
const certificateSigningRequestPath = resolve(`infra/cluster/cluster.origin.${STAGE_NAME}.csr`);
const certificateKeyPath = resolve(`infra/cluster/cluster.origin.${STAGE_NAME}.key`);

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
  secrets.k8s.OvhOriginTlsKey.name.apply((secretName) => {
    execFileSync(
      '/bin/sh',
      ['-lc', `sst secret set ${secretName} --stage ${$app.stage} < ${certificateKeyPath}`],
      { stdio: 'inherit' }
    );
  });
  needToSetCertificateSecret = true;
}

const certificateSigningRequest = readFileSync(certificateSigningRequestPath);
const ovhOriginCert = new cloudflare.OriginCaCertificate('OvhOriginCloudflareCaCertificate', {
  hostnames: [EXAMPLE_DOMAIN],
  requestType: 'origin-rsa',
  csr: certificateSigningRequest.toString(),
  requestedValidity: 5475 // 15 years
});

if (needToSetCertificateSecret) {
  $resolve([ovhOriginCert.certificate, secrets.k8s.OvhOriginTlsCrt.name]).apply(
    ([certificate, secretName]) => {
      execFileSync(
        '/bin/sh',
        ['-lc', `sst secret set ${secretName} --stage ${$app.stage} <<'EOF'\n${certificate}EOF`],
        { stdio: 'inherit' }
      );
    }
  );
}
