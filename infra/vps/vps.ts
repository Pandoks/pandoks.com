import { resolve } from 'node:path';
import { EXAMPLE_DOMAIN, STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// NOTE: if you want to downsize the cluster, remember to manually drain remove the nodes with `kubectl drain` & `kubectl delete node`
const CONTROL_PLANE_NODE_COUNT = $app.stage === 'production' ? 1 : 0;
const CONTROL_PLANE_HOST_START_OCTET = 10;
const WORKER_NODE_COUNT = $app.stage === 'production' ? 0 : 0;
const WORKER_HOST_START_OCTET = 20;
// NOTE: servers can only be upgraded, not downgraded because disk size needs to be >= than the previous type
const SERVER_TYPE = $app.stage === 'production' ? 'ccx13' : 'cpx11';
const LOAD_BALANCER_TYPE = $app.stage === 'production' ? 'lb11' : 'lb11';
const LOAD_BALANCER_ALGORITHM = 'least_connections'; // round_robin, least_connections
const SERVER_IMAGE = 'ubuntu-24.04';
const INGRESS_NODE_PORT = { http: 30080, https: 30443 };
const LOCATION = 'hil';

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
const firewall = new hcloud.Firewall('HetznerDenyIn', {
  name: 'deny-in',
  rules: []
});

const BASE_ENV = $resolve([subnet.ipRange]).apply(([PRIVATE_IP_RANGE]) => ({
  PRIVATE_IP_RANGE
}));

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

  var publicLoadBalancer = new hcloud.LoadBalancer('HetznerK3sPublicLoadBalancer', {
    name: `k3s-public-${STAGE_NAME}-load-balancer`,
    loadBalancerType: LOAD_BALANCER_TYPE,
    location: LOCATION,
    algorithm: { type: LOAD_BALANCER_ALGORITHM }
  });
  new hcloud.LoadBalancerNetwork('HetznerK3sPublicLoadBalancerNetwork', {
    loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
    networkId: privateNetwork.id.apply((id) => parseInt(id))
  });
  new hcloud.LoadBalancerService('HetznerK3sLoadBalancerPort80', {
    loadBalancerId: publicLoadBalancer.id.apply((id) => id),
    protocol: 'tcp',
    listenPort: 80,
    destinationPort: INGRESS_NODE_PORT.http,
    proxyprotocol: false,
    healthCheck: {
      protocol: 'tcp',
      port: INGRESS_NODE_PORT.http,
      interval: 10,
      timeout: 3,
      retries: 3
    }
  });
  new hcloud.LoadBalancerService('HetznerK3sLoadBalancerPort443', {
    loadBalancerId: publicLoadBalancer.id.apply((id) => id),
    protocol: 'tcp',
    listenPort: 443,
    destinationPort: INGRESS_NODE_PORT.https,
    proxyprotocol: false,
    healthCheck: {
      protocol: 'tcp',
      port: INGRESS_NODE_PORT.https,
      interval: 10,
      timeout: 3,
      retries: 3
    }
  });
}

const NODE_NAMING = {
  worker: { resourceName: 'Worker', name: 'worker' },
  controlplane: { resourceName: 'ControlPlane', name: 'control-plane' }
};

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');
const renderUserData = (envs: Record<string, string>) => {
  return cloudInitConfig.replace(/\$\{([A-Z0-9_]+)\}/g, (match, capture) =>
    capture in envs ? envs[capture] : ''
  );
};

let bootstrapServer: hcloud.Server | undefined;
let bootstrapServerIp: $util.Output<string>;
let controlPlaneServers: hcloud.Server[] = [];
for (let i = 0; i < CONTROL_PLANE_NODE_COUNT; i++) {
  const role = i === 0 ? 'bootstrap' : 'server';
  const ip = subnet.ipRange.apply(
    (ipRange) => `${ipRange.split('.').slice(0, 3).join('.')}.${CONTROL_PLANE_HOST_START_OCTET + i}`
  );
  if (role === 'bootstrap') {
    bootstrapServerIp = ip;
  }

  const envs = $resolve([
    BASE_ENV.PRIVATE_IP_RANGE,
    secrets.hetzner.K3sToken.value,
    ip,
    bootstrapServerIp!
  ]).apply(([PRIVATE_IP_RANGE, K3S_TOKEN, NODE_IP, SERVER_IP]) => {
    return {
      PRIVATE_IP_RANGE,
      K3S_TOKEN,
      SERVER_API: `https://${SERVER_IP}:6443`,
      NODE_IP,
      ROLE: role
    };
  });
  const userData = envs.apply((envs) => renderUserData(envs));
  const nodeType = NODE_NAMING.controlplane;
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
      deleteProtection: $app.stage === 'production',
      rebuildProtection: $app.stage === 'production',
      firewallIds: [firewall.id.apply((id) => parseInt(id))],
      networks: [{ networkId: privateNetwork.id.apply((id) => parseInt(id)), ip }],
      publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
      shutdownBeforeDeletion: true, // NOTE: needed to close tunnel so tunnel can be deleted without error
      userData
    },
    { dependsOn: dependencies }
  );
  bootstrapServer = bootstrapServer ?? server;
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
  const ip = subnet.ipRange.apply(
    (ipRange) => `${ipRange.split('.').slice(0, 3).join('.')}.${WORKER_HOST_START_OCTET + i}`
  );

  const envs = $resolve([
    BASE_ENV.PRIVATE_IP_RANGE,
    secrets.hetzner.K3sToken.value,
    ip,
    bootstrapServerIp!
  ]).apply(([PRIVATE_IP_RANGE, K3S_TOKEN, NODE_IP, SERVER_IP]) => {
    return {
      PRIVATE_IP_RANGE,
      K3S_TOKEN,
      SERVER_API: `https://${SERVER_IP}:6443`,
      NODE_IP,
      ROLE: 'worker'
    };
  });
  const userData = envs.apply((envs) => renderUserData(envs));
  const nodeType = NODE_NAMING.worker;
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
      deleteProtection: $app.stage === 'production',
      rebuildProtection: $app.stage === 'production',
      firewallIds: [firewall.id.apply((id) => parseInt(id))],
      networks: [{ networkId: privateNetwork.id.apply((id) => parseInt(id)), ip }],
      publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
      shutdownBeforeDeletion: true, // NOTE: needed to close tunnel so tunnel can be deleted without error
      userData
    },
    { dependsOn: dependencies }
  );
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

export const outputs = {
  K3sLoadBalancerIPv4: publicLoadBalancer! ? publicLoadBalancer.ipv4 : 'None',
  K3sPrivateSubnet: subnet.ipRange
};

export { publicLoadBalancer };
