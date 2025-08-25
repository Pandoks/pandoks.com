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

const NODE_NAMING = {
  worker: { resourceName: 'Worker', name: 'worker' },
  controlplane: { resourceName: 'ControlPlane', name: 'control-plane' }
};
const controlPlaneAccessApp = new cloudflare.ZeroTrustAccessApplication(
  `HetznerK3s${NODE_NAMING.controlplane.resourceName}SshWildcard`,
  {
    accountId: secrets.cloudflare.AccountId.value,
    name: `hetzner-k3s-${NODE_NAMING.controlplane.name}-ssh-access`,
    domain: `k3s-${NODE_NAMING.controlplane.name}-*${$app.stage === 'production' ? '' : '-dev'}.pandoks.com`,
    type: 'ssh',
    sessionDuration: '24h',
    autoRedirectToIdentity: true,
    policies: [
      {
        name: 'allow-admin',
        decision: 'allow',
        precedence: 1,
        includes: [{ email: { email: secrets.cloudflare.Email.value } }],
        connectionRules: { ssh: { usernames: ['pandoks'] } }
      },
      {
        name: 'deny-all',
        decision: 'deny',
        precedence: 2,
        includes: [{ everyone: {} }]
      }
    ]
  }
);
const controlPlaneSshShortLivedToken = new cloudflare.ZeroTrustAccessShortLivedCertificate(
  `Hetzner${NODE_NAMING.controlplane.resourceName}SshShortLivedCertificate`,
  {
    accountId: secrets.cloudflare.AccountId.value,
    appId: controlPlaneAccessApp.id
  }
);
const workerAccessApp = new cloudflare.ZeroTrustAccessApplication(
  `HetznerK3s${NODE_NAMING.worker.resourceName}SshWildcard`,
  {
    accountId: secrets.cloudflare.AccountId.value,
    name: `hetzner-k3s-${NODE_NAMING.worker.name}-ssh-access`,
    domain: `k3s-${NODE_NAMING.worker.name}-*${$app.stage === 'production' ? '' : '-dev'}.pandoks.com`,
    type: 'ssh',
    sessionDuration: '24h',
    autoRedirectToIdentity: true,
    policies: [
      {
        name: 'allow-admin',
        decision: 'allow',
        precedence: 1,
        includes: [{ email: { email: secrets.cloudflare.Email.value } }],
        connectionRules: { ssh: { usernames: ['pandoks'] } }
      },
      {
        name: 'deny-all',
        decision: 'deny',
        precedence: 2,
        includes: [{ everyone: {} }]
      }
    ]
  }
);
const workerSshShortLivedToken = new cloudflare.ZeroTrustAccessShortLivedCertificate(
  `Hetzner${NODE_NAMING.worker.resourceName}SshShortLivedCertificate`,
  {
    accountId: secrets.cloudflare.AccountId.value,
    appId: workerAccessApp.id
  }
);

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');
const renderUserData = (envs: Record<string, string>) => {
  return cloudInitConfig.replace(/\$\{([A-Z0-9_]+)\}/g, (match, capture) =>
    capture in envs ? envs[capture] : ''
  );
};

const CONTROL_PLANE_NODE_COUNT = $app.stage === 'production' ? 3 : 1;
const CONTROL_PLANE_HOST_START_OCTET = 10;
const WORKER_NODE_COUNT = $app.stage === 'production' ? 1 : 0;
const WORKER_HOST_START_OCTET = 20;
const SERVER_TYPE = $app.stage === 'production' ? 'ccx13' : 'cpx11';
const BASE_ENV = $resolve([
  secrets.cloudflare.AccountId.value,
  secrets.hetzner.TunnelSecret.value,
  subnet.ipRange,
  controlPlaneSshShortLivedToken.publicKey
]).apply(([ACCOUNT_ID, TUNNEL_SECRET, PRIVATE_IP_RANGE, SSH_CA_PUB]) => ({
  ACCOUNT_ID,
  TUNNEL_SECRET,
  PRIVATE_IP_RANGE,
  SSH_CA_PUB
}));

const setupTunnelSsh = (index: number, options: { isWorker?: boolean; hostname: string }) => {
  const nodeType = options.isWorker ? NODE_NAMING.worker : NODE_NAMING.controlplane;

  const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(
    `HetznerK3s${nodeType.resourceName}Tunnel${index}`,
    {
      name: `${$app.stage == 'production' ? 'prod' : 'dev'}-hetzner-k3s-${nodeType.name}-tunnel-${index}`,
      accountId: secrets.cloudflare.AccountId.value,
      configSrc: 'local',
      tunnelSecret: secrets.hetzner.TunnelSecret.value
    }
  );
  new cloudflare.ZeroTrustTunnelCloudflaredConfig(
    `HetznerK3s${nodeType.resourceName}TunnelConfig${index}`,
    {
      accountId: secrets.cloudflare.AccountId.value,
      tunnelId: tunnel.id,
      config: {
        ingresses: [
          { hostname: options.hostname, service: 'ssh://localhost:22' },
          { service: 'http_status:404' }
        ]
      }
    }
  );
  new cloudflare.ZeroTrustTunnelCloudflaredRoute(
    `HetznerK3s${nodeType.resourceName}Route${index}`,
    {
      accountId: secrets.cloudflare.AccountId.value,
      tunnelId: tunnel.id,
      network: subnet.ipRange
    }
  );
  const ipAddr = subnet.ipRange.apply(
    (ipRange) =>
      `${ipRange.split('.').slice(0, 3).join('.')}.${options.isWorker ? WORKER_HOST_START_OCTET + index : CONTROL_PLANE_HOST_START_OCTET + index}`
  );
  new cloudflare.ZeroTrustAccessInfrastructureTarget(
    `HetznerK3s${nodeType.resourceName}Target${index}`,
    {
      accountId: secrets.cloudflare.AccountId.value,
      hostname: options.hostname.split('.')[0],
      ip: { ipv4: { ipAddr } }
    }
  );
  new cloudflare.DnsRecord(`HetznerK3s${nodeType.resourceName}SshHost${index}`, {
    zoneId: secrets.cloudflare.ZoneId.value,
    name: options.hostname,
    type: 'CNAME',
    content: $interpolate`${tunnel.id}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: 'hetzner tunnel k3s'
  });
  return tunnel;
};

const createServer = (
  index: number,
  userData: $util.Input<string>,
  options: { isWorker?: boolean; hostname: string; location: string }
) => {
  const nodeType = options.isWorker ? NODE_NAMING.worker : NODE_NAMING.controlplane;
  const ip = subnet.ipRange.apply(
    (ipRange) =>
      `${ipRange.split('.').slice(0, 3).join('.')}.${options.isWorker ? WORKER_HOST_START_OCTET + index : CONTROL_PLANE_HOST_START_OCTET + index}`
  );

  return new hcloud.Server(`Hetzner${nodeType.resourceName}Server${index}`, {
    name: `${$app.stage == 'production' ? 'prod' : 'dev'}-${nodeType.name}-server-${index}`,
    serverType: SERVER_TYPE,
    image: 'ubuntu-24.04',
    location: index & 1 ? 'ash' : 'hil',
    deleteProtection: $app.stage === 'production',
    rebuildProtection: $app.stage === 'production',
    firewallIds: [firewall.id.apply((id) => parseInt(id))],
    networks: [{ networkId: privateNetwork.id.apply((id) => parseInt(id)), ip }],
    publicNets: [
      {
        ipv4Enabled: true,
        ipv6Enabled: true
      }
    ],
    userData
  });
};

let controlPlaneServers: hcloud.Server[] = [];
for (let i = 0; i < CONTROL_PLANE_NODE_COUNT; i++) {
  const sshHostname = `k3s-${NODE_NAMING.controlplane.name}-${i}${$app.stage === 'production' ? '' : '-dev'}.pandoks.com`;

  const tunnel = setupTunnelSsh(i, { hostname: sshHostname });

  const envs = $resolve([
    tunnel.id,
    BASE_ENV.ACCOUNT_ID,
    BASE_ENV.TUNNEL_SECRET,
    BASE_ENV.SSH_CA_PUB,
    BASE_ENV.PRIVATE_IP_RANGE
  ]).apply(([TUNNEL_ID, ACCOUNT_ID, TUNNEL_SECRET, SSH_CA_PUB, PRIVATE_IP_RANGE]) => {
    return {
      SSH_HOSTNAME: sshHostname,
      TUNNEL_ID,
      ACCOUNT_ID,
      TUNNEL_SECRET,
      SSH_CA_PUB,
      PRIVATE_IP_RANGE
    };
  });
  const userData = envs.apply((envs) => renderUserData(envs));
  const server = createServer(i, userData, { hostname: sshHostname, location: 'hil' });
  controlPlaneServers.push(server);
}
controlPlaneServers.forEach((server, index) => {
  new hcloud.LoadBalancerTarget(
    `HetznerK3s${NODE_NAMING.controlplane.resourceName}LoadBalancerTarget${index}`,
    {
      loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
      type: 'server',
      serverId: server.id.apply((id) => parseInt(id)),
      usePrivateIp: true
    }
  );
});

let workerServers: hcloud.Server[] = [];
for (let i = 0; i < WORKER_NODE_COUNT; i++) {
  const sshHostname = `k3s-${NODE_NAMING.worker.name}-${i}${$app.stage === 'production' ? '' : '-dev'}.pandoks.com`;

  const tunnel = setupTunnelSsh(i, { hostname: sshHostname, isWorker: true });

  const envs = $resolve([
    tunnel.id,
    BASE_ENV.ACCOUNT_ID,
    BASE_ENV.TUNNEL_SECRET,
    BASE_ENV.SSH_CA_PUB,
    BASE_ENV.PRIVATE_IP_RANGE
  ]).apply(([TUNNEL_ID, ACCOUNT_ID, TUNNEL_SECRET, SSH_CA_PUB, PRIVATE_IP_RANGE]) => {
    return {
      SSH_HOSTNAME: sshHostname,
      TUNNEL_ID,
      ACCOUNT_ID,
      TUNNEL_SECRET,
      SSH_CA_PUB,
      PRIVATE_IP_RANGE
    };
  });
  const userData = envs.apply((envs) => renderUserData(envs));
  const server = createServer(i, userData, {
    hostname: sshHostname,
    location: 'hil',
    isWorker: true
  });
  workerServers.push(server);
}
workerServers.forEach((server, index) => {
  new hcloud.LoadBalancerTarget(
    `HetznerK3s${NODE_NAMING.worker.resourceName}LoadBalancerTarget${index}`,
    {
      loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
      type: 'server',
      serverId: server.id.apply((id) => parseInt(id)),
      usePrivateIp: true
    }
  );
});

export const loadBalancerIPv4 = publicLoadBalancer.ipv4;
