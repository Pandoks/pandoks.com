import { secrets } from '../secrets';
import { readFileSync } from 'node:fs';

const privateNetwork = new hcloud.Network('HetznerK3sPrivateNetwork', {
  name: `k3s-private-${$app.stage === 'production' ? 'prod' : 'dev'}-network`,
  ipRange: '10.0.0.0/8'
});
const subnet = new hcloud.NetworkSubnet('HetznerK3sSubnet', {
  networkId: privateNetwork.id.apply((id) => parseInt(id)),
  type: 'cloud',
  ipRange: '10.0.1.0/24',
  networkZone: 'us-west'
});
const firewall = new hcloud.Firewall('HetznerDenyIn', {
  name: 'deny-in',
  rules: []
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

const warpPolicy = new cloudflare.ZeroTrustAccessPolicy('HetznerK3sCloudflareWarpDevicePolicy', {
  accountId: secrets.cloudflare.AccountId.value,
  name: 'allow-pandoks-warp',
  decision: 'allow',
  includes: [{ email: { email: secrets.cloudflare.Email.value } }]
});

new cloudflare.ZeroTrustAccessApplication('HetznerK3sSshWildcard', {
  accountId: secrets.cloudflare.AccountId.value,
  name: 'hetzner-k3s-ssh-access',
  type: 'warp',
  autoRedirectToIdentity: true,
  appLauncherVisible: false,
  policies: [{ id: warpPolicy.id, precedence: 1 }]
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
  new cloudflare.ZeroTrustTunnelCloudflaredConfig(`HetznerK3sNodeTunnelWarp${i}`, {
    accountId: secrets.cloudflare.AccountId.value,
    tunnelId: tunnel.id,
    config: {
      warpRouting: { enabled: true },
      ingresses: [{ service: 'http_status:404' }]
    }
  });
  new cloudflare.ZeroTrustTunnelCloudflaredRoute(`HetznerK3sWarpRoute${i}`, {
    accountId: secrets.cloudflare.AccountId.value,
    tunnelId: tunnel.id,
    network: `10.0.1.${10 + i}/32`
  });
  new cloudflare.ZeroTrustAccessInfrastructureTarget(`HetznerK3sTarget${i}`, {
    accountId: secrets.cloudflare.AccountId.value,
    hostname: `k3s-node-${i}${$app.stage === 'production' ? '' : '-dev'}`,
    ip: {
      ipv4: {
        ipAddr: `10.0.1.${10 + i}`
      }
    }
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
    tunnel.id,
    subnet.ipRange
  ]).apply(([ACCOUNT_ID, TUNNEL_SECRET, TUNNEL_ID, PRIVATE_IP_RANGE]) => ({
    ACCOUNT_ID,
    TUNNEL_SECRET,
    TUNNEL_ID,
    PRIVATE_IP_RANGE
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
      firewallIds: [firewall.id.apply((id) => parseInt(id))],
      networks: [
        { networkId: privateNetwork.id.apply((id) => parseInt(id)), ip: `10.0.1.${10 + i}` }
      ],
      publicNets: [
        {
          ipv4Enabled: true,
          ipv6Enabled: true
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
