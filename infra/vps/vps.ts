import { secrets } from '../secrets';
import { readFileSync } from 'node:fs';

const privateNetwork = new hcloud.Network('HetznerK3sPrivateNetwork', {
  name: `k3s-private-${$app.stage === 'production' ? 'prod' : 'dev'}-network`,
  ipRange: '10.0.0.0/8'
});
new hcloud.NetworkSubnet('HetznerK3sSubnet', {
  networkId: privateNetwork.id.apply((id) => parseInt(id)),
  type: 'cloud',
  ipRange: '10.0.1.0/24',
  networkZone: 'us-west'
});

const publicLoadBalancer = new hcloud.LoadBalancer('HetznerK3sPublicLoadBalancer', {
  name: `k3s-public-${$app.stage === 'production' ? 'prod' : 'dev'}-load-balancer`,
  loadBalancerType: 'lb11',
  location: 'hil'
});
new hcloud.LoadBalancerNetwork('HetznerK3sPublicLoadBalancerNetwork', {
  loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
  networkId: privateNetwork.id.apply((id) => parseInt(id))
});
new hcloud.LoadBalancerService('HetznerK3sLoadBalancerPort80', {
  loadBalancerId: publicLoadBalancer.id.apply((id) => id),
  protocol: 'tcp',
  listenPort: 80,
  destinationPort: 80,
  proxyprotocol: false,
  healthCheck: {
    protocol: 'http',
    port: 80,
    interval: 10,
    timeout: 3,
    retries: 3,
    http: { path: '/', statusCodes: ['2??', '3??'] }
  }
});
new hcloud.LoadBalancerService('HetznerK3sLoadBalancerPort443', {
  loadBalancerId: publicLoadBalancer.id.apply((id) => id),
  protocol: 'tcp',
  listenPort: 443,
  destinationPort: 443,
  proxyprotocol: false,
  healthCheck: {
    protocol: 'tcp',
    port: 443,
    interval: 10,
    timeout: 3,
    retries: 3
  }
});

new cloudflare.ZeroTrustAccessApplication('HetznerK3sSshWildcard', {
  accountId: secrets.cloudflare.AccountId.value,
  name: 'hetzner-k3s-ssh-access',
  domain: `k3s-node-*${$app.stage === 'production' ? '' : '-dev'}.pandoks.com`,
  type: 'ssh',
  sessionDuration: '24h',
  autoRedirectToIdentity: true,
  policies: [
    {
      name: 'allow-admin',
      decision: 'allow',
      precedence: 1,
      includes: [{ email: { email: secrets.cloudflare.Email.value } }]
    },
    {
      name: 'deny-all',
      decision: 'deny',
      precedence: 2,
      includes: [{ everyone: {} }]
    }
  ]
});

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');
const renderUserData = (envs: Record<string, string>) => {
  return cloudInitConfig.replace(/\$\{([A-Z0-9_]+)\}/g, (match, capture) =>
    capture in envs ? envs[capture] : ''
  );
};

const NODES = $app.stage === 'production' ? 3 : 1;
const SERVER_TYPE = $app.stage === 'production' ? 'ccx13' : 'cpx11';

let servers: hcloud.Server[] = [];
for (let i = 0; i < NODES; i++) {
  const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(`HetznerK3sNodeTunnel${i}`, {
    name: `${$app.stage == 'production' ? 'prod' : 'dev'}-hetzner-k3s-tunnel-${i}`,
    accountId: secrets.cloudflare.AccountId.value,
    configSrc: 'local',
    tunnelSecret: secrets.hetzner.TunnelSecret.value
  });
  const sshHostname = `k3s-node-${i}${$app.stage === 'production' ? '' : '-dev'}.pandoks.com`;
  new cloudflare.DnsRecord(`HetznerK3sNodeSshHost${i}`, {
    zoneId: secrets.cloudflare.ZoneId.value,
    name: sshHostname,
    type: 'CNAME',
    content: $interpolate`${tunnel.id}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: 'hetzner tunnel k3s'
  });

  const envs = $resolve([
    secrets.cloudflare.AccountId.value,
    secrets.hetzner.TunnelSecret.value,
    tunnel.id
  ]).apply(([accountId, tunnelSecret, tunnelId]) => ({
    SSH_HOSTNAME: sshHostname,
    ACCOUNT_ID: accountId,
    TUNNEL_SECRET: tunnelSecret,
    TUNNEL_ID: tunnelId
  }));
  const userData = envs.apply((envs) => renderUserData(envs));

  servers.push(
    new hcloud.Server(`HetznerServer${i}`, {
      name: `${$app.stage == 'production' ? 'prod' : 'dev'}-server-${i}`,
      serverType: SERVER_TYPE,
      image: 'ubuntu-24.04',
      location: 'hil',
      deleteProtection: $app.stage === 'production',
      rebuildProtection: $app.stage === 'production',
      networks: [
        { networkId: privateNetwork.id.apply((id) => parseInt(id)), ip: `10.0.1.${10 + i}` }
      ],
      publicNets: [
        {
          ipv4: 0,
          ipv4Enabled: false,
          ipv6: 0,
          ipv6Enabled: false
        }
      ],
      userData
    })
  );
}
servers.forEach((server, index) => {
  new hcloud.LoadBalancerTarget(`HetznerK3sLoadBalancerTarget${index}`, {
    loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
    type: 'server',
    serverId: server.id.apply((id) => parseInt(id)),
    usePrivateIp: true
  });
});

export const loadBalancerIPv4 = publicLoadBalancer.ipv4;
