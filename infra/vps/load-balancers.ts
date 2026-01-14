import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EXAMPLE_DOMAIN, STAGE_NAME } from '../dns';
import { secrets } from '../secrets';

const openSslConfigPath = resolve('infra/vps/vps.openssl.conf');
const certificateSigningRequestPath = resolve(`infra/vps/vps.origin.${STAGE_NAME}.csr`);
const certificateKeyPath = resolve(`infra/vps/vps.origin.${STAGE_NAME}.key`);

export function createLoadBalancers(
  loadBalancerArgs: {
    controlPlaneCount: number;
    workerNodeCount: number;
    loadBalancerCount: number;
    network: hcloud.Network;
  },
  hcloudLoadBalancerArgs: {
    type: string;
    location: string;
    alogrithm: string;
  }
): { loadbalancer: hcloud.LoadBalancer; network: hcloud.LoadBalancerNetwork }[] {
  if (
    loadBalancerArgs.loadBalancerCount ||
    (!loadBalancerArgs.controlPlaneCount && !loadBalancerArgs.workerNodeCount)
  ) {
    return [];
  }

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

  let publicLoadBalancers: {
    loadbalancer: hcloud.LoadBalancer;
    network: hcloud.LoadBalancerNetwork;
  }[] = [];
  for (let i = 0; i < loadBalancerArgs.loadBalancerCount; i++) {
    const publicLoadBalancer = new hcloud.LoadBalancer(`HetznerK3sPublicLoadBalancer${i}`, {
      name: `k3s-public-${STAGE_NAME}-load-balancer-${i}`,
      loadBalancerType: hcloudLoadBalancerArgs.type,
      location: hcloudLoadBalancerArgs.location,
      algorithm: { type: hcloudLoadBalancerArgs.alogrithm }
    });
    const publicLoadBalancerNetwork = new hcloud.LoadBalancerNetwork(
      `HetznerK3sPublicLoadBalancer${i}Network`,
      {
        loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
        networkId: loadBalancerArgs.network.id.apply((id) => parseInt(id))
      }
    );
    // Only enable https on the load balancer because we're using Cloudflare Strict
    new hcloud.LoadBalancerService(`HetznerK3sLoadBalancer${i}Port443`, {
      loadBalancerId: publicLoadBalancer.id.apply((id) => id),
      protocol: 'tcp',
      listenPort: 443,
      destinationPort: 30443,
      // NOTE: needed to validate all requests are coming from Cloudflare (false will only show load balancer's private network ip)
      proxyprotocol: true,
      healthCheck: {
        protocol: 'tcp',
        port: 30443,
        interval: 10,
        timeout: 3,
        retries: 3
      }
    });
    publicLoadBalancers.push({
      loadbalancer: publicLoadBalancer,
      network: publicLoadBalancerNetwork
    });
  }

  return publicLoadBalancers;
}
