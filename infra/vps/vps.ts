// WARNING: resources that hold data like servers, volumes, etc. should be protected by the
// `protect` option in production. This is to prevent accidental deletion of resources.
import { resolve } from 'node:path';
import { EXAMPLE_DOMAIN, STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tailscaleAcl } from '../tailscale';

const isProduction = $app.stage === 'production';
const stageName = isProduction ? 'prod' : 'dev';

// NOTE: if you want to downsize the cluster, remember to manually drain remove the nodes with `kubectl drain` & `kubectl delete node`
const CONTROL_PLANE_NODE_COUNT = isProduction ? 1 : 1;
const CONTROL_PLANE_HOST_START_OCTET = 10; // starts at 10.0.1.<CONTROL_PLANE_HOST_START_OCTET>
const WORKER_NODE_COUNT = isProduction ? 0 : 0;
const WORKER_HOST_START_OCTET = 20; // starts at 10.0.1.<WORKER_HOST_START_OCTET> 20 allows for 10 control plane nodes
// NOTE: servers can only be upgraded, not downgraded because disk size needs to be >= than the previous type
const SERVER_TYPE = isProduction ? 'ccx13' : 'cpx11';
const LOAD_BALANCER_COUNT = isProduction ? 1 : 0;
const LOAD_BALANCER_TYPE = isProduction ? 'lb11' : 'lb11';
const LOAD_BALANCER_ALGORITHM = 'least_connections'; // round_robin, least_connections
const SERVER_IMAGE = 'ubuntu-24.04';
const INGRESS_HTTPS_NODE_PORT = 30443;
const LOCATION = 'hil';
const NODE_NAMING = {
  worker: { resourceName: 'Worker', name: 'worker' },
  controlplane: { resourceName: 'ControlPlane', name: 'control-plane' }
};
const BASE_TAILSCALE_TAGS = ['tag:hetzner', `tag:${stageName}`];

/**
 * NOTE: Hetzner doesn't allow you to connect servers from different regions in the same network.
 * Networks are only created in a single region. If you want to have multiple reigions to reduce latency,
 * you need to create multiple clusters and networks in different regions. You don't need to connect them
 * via a VPN or through the public internet.
 *
 * To have multiple regions work, look into Cloudflare DNS load balancers. You can steer traffic based
 * off of "geo steering" or "proximity/latency". This costs extra, so stay in one region until latency
 * is an issue.
 *
 * You'll probably want to rename a bunch of the resources and variable names when you do.
 */
const privateNetwork = new hcloud.Network('HetznerK3sPrivateNetwork', {
  name: `k3s-private-${STAGE_NAME}-network`,
  ipRange: '10.0.0.0/8'
});
const subnet = new hcloud.NetworkSubnet('HetznerK3sSubnet', {
  networkId: privateNetwork.id.apply((id) => parseInt(id)),
  type: 'cloud',
  ipRange: '10.0.1.0/24',
  networkZone: 'us-west'
});
const firewall = new hcloud.Firewall('HetznerInboundFirewall', {
  name: 'inbound',
  rules: [
    {
      direction: 'in',
      protocol: 'udp',
      port: '41641',
      description: 'tailscale',
      sourceIps: ['0.0.0.0/0', '::/0']
    }
  ]
});

let publicLoadBalancers: [hcloud.LoadBalancer, hcloud.LoadBalancerNetwork][] = [];
if (CONTROL_PLANE_NODE_COUNT + WORKER_NODE_COUNT) {
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

  for (let i = 0; i < LOAD_BALANCER_COUNT; i++) {
    const publicLoadBalancer = new hcloud.LoadBalancer(`HetznerK3sPublicLoadBalancer${i}`, {
      name: `k3s-public-${STAGE_NAME}-load-balancer-${i}`,
      loadBalancerType: LOAD_BALANCER_TYPE,
      location: LOCATION,
      algorithm: { type: LOAD_BALANCER_ALGORITHM }
    });
    const publicLoadBalancerNetwork = new hcloud.LoadBalancerNetwork(
      `HetznerK3sPublicLoadBalancer${i}Network`,
      {
        loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
        networkId: privateNetwork.id.apply((id) => parseInt(id))
      }
    );
    // Only enable https on the load balancer because we're using Cloudflare Strict
    new hcloud.LoadBalancerService(`HetznerK3sLoadBalancer${i}Port443`, {
      loadBalancerId: publicLoadBalancer.id.apply((id) => id),
      protocol: 'tcp',
      listenPort: 443,
      destinationPort: INGRESS_HTTPS_NODE_PORT,
      // NOTE: needed to validate all requests are coming from Cloudflare (false will only show load balancer's private network ip)
      proxyprotocol: true,
      healthCheck: {
        protocol: 'tcp',
        port: INGRESS_HTTPS_NODE_PORT,
        interval: 10,
        timeout: 3,
        retries: 3
      }
    });
    publicLoadBalancers.push([publicLoadBalancer, publicLoadBalancerNetwork]);
  }
}

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');
function renderUserData(envs: Record<string, string>) {
  return cloudInitConfig.replace(/\$\{([A-Z0-9_]+)\}/g, (_, capture) =>
    capture in envs ? envs[capture] : ''
  );
}

let bootstrapServer: hcloud.Server | undefined;
let bootstrapServerIp: $util.Output<string>;
let controlPlaneServers: hcloud.Server[] = [];
let controlPlaneTailscaleHostnames: string[] = [];
for (let i = 0; i < CONTROL_PLANE_NODE_COUNT; i++) {
  const role = i === 0 ? 'bootstrap' : 'server';
  const ip = subnet.ipRange.apply(
    (ipRange) => `${ipRange.split('.').slice(0, 3).join('.')}.${CONTROL_PLANE_HOST_START_OCTET + i}`
  );
  if (role === 'bootstrap') {
    bootstrapServerIp = ip;
  }

  const nodeType = NODE_NAMING.controlplane;
  const registrationTailnetAuthKey = new tailscale.TailnetKey(
    `Hetzner${nodeType.resourceName}Server${i}TailnetRegistrationAuthKey`,
    {
      description: `hcloud ${nodeType.name} ${i} node reg`,
      reusable: false,
      expiry: 1800, // 30 minutes
      preauthorized: true,
      tags: ['tag:control-plane', ...BASE_TAILSCALE_TAGS]
    },
    {
      dependsOn: [tailscaleAcl]
    }
  );

  const tailscaleHostname = `${stageName}-hetzner-${nodeType.name}-server-${i}`;
  controlPlaneTailscaleHostnames.push(tailscaleHostname);

  const envs = $resolve([
    subnet.ipRange,
    secrets.hetzner.K3sToken.value,
    ip,
    bootstrapServerIp!,
    registrationTailnetAuthKey.key
  ]).apply(([PRIVATE_IP_RANGE, K3S_TOKEN, NODE_IP, SERVER_IP, REGISTRATION_TAILNET_AUTH_KEY]) => {
    return {
      PRIVATE_IP_RANGE,
      K3S_TOKEN,
      SERVER_API: `https://${SERVER_IP}:6443`,
      NODE_IP,
      ROLE: role,
      TAILSCALE_HOSTNAME: tailscaleHostname,
      REGISTRATION_TAILNET_AUTH_KEY
    };
  });
  const userData = envs.apply((envs) => renderUserData(envs));
  // NOTE: needed to create servers sequentially
  const dependencies = [bootstrapServer, controlPlaneServers.at(-1)].filter(
    (resource) => resource !== undefined
  );
  const server = new hcloud.Server(
    `Hetzner${nodeType.resourceName}Server${i}`,
    {
      name: `${$app.stage == 'production' ? 'prod' : 'dev'}-${nodeType.name}-server-${i}`,
      serverType: SERVER_TYPE,
      image: SERVER_IMAGE,
      location: LOCATION,
      deleteProtection: isProduction,
      rebuildProtection: isProduction,
      firewallIds: [firewall.id.apply((id) => parseInt(id))],
      networks: [{ networkId: privateNetwork.id.apply((id) => parseInt(id)), ip }],
      publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
      shutdownBeforeDeletion: true,
      userData
    },
    { dependsOn: dependencies, protect: isProduction }
  );
  bootstrapServer = bootstrapServer ?? server;
  controlPlaneServers.push(server);
}
controlPlaneServers.forEach((server, index) => {
  for (const [i, [loadBalancer, loadBalancerNetwork]] of publicLoadBalancers.entries()) {
    new hcloud.LoadBalancerTarget(
      `HetznerK3s${NODE_NAMING.controlplane.resourceName}LoadBalancer${i}Target${index}`,
      {
        loadBalancerId: loadBalancer.id.apply((id) => parseInt(id)),
        type: 'server',
        serverId: server.id.apply((id) => parseInt(id)),
        usePrivateIp: true
      },
      { dependsOn: [loadBalancerNetwork] }
    );
  }
});

let workerServers: hcloud.Server[] = [];
let workerTailscaleHostnames: string[] = [];
for (let i = 0; i < WORKER_NODE_COUNT; i++) {
  const ip = subnet.ipRange.apply(
    (ipRange) => `${ipRange.split('.').slice(0, 3).join('.')}.${WORKER_HOST_START_OCTET + i}`
  );

  const nodeType = NODE_NAMING.worker;
  const registrationTailnetAuthKey = new tailscale.TailnetKey(
    `Hetzner${nodeType.resourceName}Server${i}TailnetRegistrationAuthKey`,
    {
      description: `hcloud ${nodeType.name} ${i} node reg`,
      reusable: false,
      expiry: 1800, // 30 minutes
      preauthorized: true,
      tags: ['tag:worker', ...BASE_TAILSCALE_TAGS]
    },
    { dependsOn: [tailscaleAcl] }
  );

  const tailscaleHostname = `${stageName}-hetzner-${nodeType.name}-server-${i}`;
  workerTailscaleHostnames.push(tailscaleHostname);

  const envs = $resolve([
    subnet.ipRange,
    secrets.hetzner.K3sToken.value,
    ip,
    bootstrapServerIp!,
    registrationTailnetAuthKey.key
  ]).apply(([PRIVATE_IP_RANGE, K3S_TOKEN, NODE_IP, SERVER_IP, REGISTRATION_TAILNET_AUTH_KEY]) => {
    return {
      PRIVATE_IP_RANGE,
      K3S_TOKEN,
      SERVER_API: `https://${SERVER_IP}:6443`,
      NODE_IP,
      ROLE: 'worker',
      TAILSCALE_HOSTNAME: tailscaleHostname,
      REGISTRATION_TAILNET_AUTH_KEY
    };
  });
  const userData = envs.apply((envs) => renderUserData(envs));
  // NOTE: needed to create servers sequentially
  const dependencies = [bootstrapServer, workerServers.at(-1)].filter(
    (resource) => resource !== undefined
  );
  const server = new hcloud.Server(
    `Hetzner${nodeType.resourceName}Server${i}`,
    {
      name: `${$app.stage == 'production' ? 'prod' : 'dev'}-${nodeType.name}-server-${i}`,
      serverType: SERVER_TYPE,
      image: SERVER_IMAGE,
      location: LOCATION,
      deleteProtection: isProduction,
      rebuildProtection: isProduction,
      firewallIds: [firewall.id.apply((id) => parseInt(id))],
      networks: [{ networkId: privateNetwork.id.apply((id) => parseInt(id)), ip }],
      publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
      shutdownBeforeDeletion: true,
      userData
    },
    { dependsOn: dependencies, protect: isProduction }
  );
  workerServers.push(server);
}
workerServers.forEach((server, index) => {
  for (const [i, [loadBalancer, loadBalancerNetwork]] of publicLoadBalancers.entries()) {
    new hcloud.LoadBalancerTarget(
      `HetznerK3s${NODE_NAMING.worker.resourceName}LoadBalancer${i}Target${index}`,
      {
        loadBalancerId: loadBalancer.id.apply((id) => parseInt(id)),
        type: 'server',
        serverId: server.id.apply((id) => parseInt(id)),
        usePrivateIp: true
      },
      { dependsOn: [loadBalancerNetwork] }
    );
  }
});

const tailscaleApiUrl = 'https://api.tailscale.com/api/v2';
const tailscaleDeviceJson = new command.local.Command('CleanupHetznerTailscale', {
  create: `curl -sS -u "$TAILSCALE_API_KEY:" '${tailscaleApiUrl}/tailnet/pandoks.github/devices?${BASE_TAILSCALE_TAGS.map((tag) => `tags=${tag}`).join('&')}'`,
  environment: { TAILSCALE_API_KEY: secrets.tailscale.ApiKey.value },
  interpreter: ['/bin/sh', '-c'],
  logging: command.local.Logging.None,
  triggers: [
    ...controlPlaneServers.map((server) => server.id),
    ...workerServers.map((server) => server.id)
  ]
});
$resolve([secrets.tailscale.ApiKey.value, tailscaleDeviceJson.stdout]).apply(
  async ([apiKey, tailscaleDeviceListStdOut]) => {
    const tailscaleDeviceList: {
      devices: {
        id: string;
        name: string;
        hostname: string;
        tags: string[];
        [key: string]: string[] | string | boolean;
      }[];
    } = JSON.parse(tailscaleDeviceListStdOut);
    const devices = tailscaleDeviceList.devices;
    for (const device of devices) {
      const tags = device.tags;
      const validHostnames = tags.includes('tag:control-plane')
        ? controlPlaneTailscaleHostnames
        : workerTailscaleHostnames;

      const hostname = device.hostname;
      if (validHostnames.includes(hostname)) continue;

      const deviceId = device.id;
      await fetch(`${tailscaleApiUrl}/device/${deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` }
      });
    }
  }
);

const publicLoadBalancerOutputs = Object.fromEntries(
  publicLoadBalancers.map(([loadBalancer, _], index) => [
    `K3sLoadBalancer${index}Ipv4`,
    loadBalancer.ipv4 ?? 'None'
  ])
);

export const outputs = {
  ...publicLoadBalancerOutputs
};

export { publicLoadBalancers };
