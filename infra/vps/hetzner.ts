import { isProduction, STAGE_NAME } from '../dns';
import { createLoadBalancers } from './load-balancers';
import {
  createNodeUserData,
  createTailnetCleanupHook,
  getNodeIp,
  NODE_RESOURCE_NAMES,
  PRIVATE_IP_RANGE,
  type NodeCounts,
  type NodeType
} from './servers';

// NOTE: servers can only be upgraded, not downgraded because disk size needs to be >= than the previous type
const SERVER_TYPE = isProduction ? 'ccx13' : 'cx23';
const LOAD_BALANCERS_PER_NODE = isProduction ? 1 : 0;
const LOAD_BALANCER_TYPE = isProduction ? 'lb11' : 'lb11';
const LOAD_BALANCER_ALGORITHM = 'least_connections'; // round_robin, least_connections
const SERVER_IMAGE = 'ubuntu-24.04';
const LOCATION = isProduction ? 'hil' : 'fsn1';
const NETWORK_ZONE = isProduction ? 'us-west' : 'eu-central';
const PRIVATE_INTERFACE = 'enp7s0';

const loadBalancerServerCapacity = 25;

const deleteServerFromTailnet = createTailnetCleanupHook({
  name: 'DeleteServerFromTailnet',
  provider: 'hetzner',
  getTailscaleHostname: (oldOutputs) =>
    (oldOutputs.labels as $util.Unwrap<hcloud.Server['labels']> | undefined)?.tailscale
});

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
export function createHetznerCluster(nodeCounts: NodeCounts) {
  const privateNetwork = new hcloud.Network('HetznerK3sPrivateNetwork', {
    name: `k3s-private-${STAGE_NAME}-network`,
    ipRange: '10.0.0.0/8'
  });
  const subnet = new hcloud.NetworkSubnet('HetznerK3sSubnet', {
    networkId: privateNetwork.id.apply((id) => parseInt(id)),
    type: 'cloud',
    ipRange: PRIVATE_IP_RANGE,
    networkZone: NETWORK_ZONE
  });
  const inboundFirewall = new hcloud.Firewall('HetznerInboundFirewall', {
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

  const controlPlaneLoadBalancers = createLoadBalancers(
    {
      type: 'control-plane',
      loadBalancerCount:
        Math.ceil(nodeCounts['control-plane'] / loadBalancerServerCapacity) *
        LOAD_BALANCERS_PER_NODE,
      network: privateNetwork
    },
    { type: LOAD_BALANCER_TYPE, location: LOCATION, algorithm: LOAD_BALANCER_ALGORITHM }
  );
  const workerLoadBalancers = createLoadBalancers(
    {
      type: 'worker',
      loadBalancerCount:
        Math.ceil(nodeCounts.worker / loadBalancerServerCapacity) * LOAD_BALANCERS_PER_NODE,
      network: privateNetwork
    },
    { type: LOAD_BALANCER_TYPE, location: LOCATION, algorithm: LOAD_BALANCER_ALGORITHM }
  );

  const servers: hcloud.Server[] = [];
  for (const type of ['control-plane', 'worker', 'database'] as const) {
    servers.push(
      ...createServers({
        type,
        serverCount: nodeCounts[type],
        network: { network: privateNetwork, subnet },
        firewalls: [inboundFirewall],
        previousServer: servers.at(-1),
        bootstrapServer: servers[0],
        loadBalancers: type === 'control-plane' ? controlPlaneLoadBalancers : workerLoadBalancers
      })
    );
  }

  return { controlPlaneLoadBalancers, workerLoadBalancers };
}

function createServers({
  type,
  serverCount,
  network,
  firewalls,
  previousServer,
  bootstrapServer,
  loadBalancers
}: {
  type: NodeType;
  serverCount: number;
  network: { network: hcloud.Network; subnet: hcloud.NetworkSubnet };
  firewalls: hcloud.Firewall[];
  previousServer: hcloud.Server | undefined;
  bootstrapServer: hcloud.Server | undefined;
  loadBalancers: ReturnType<typeof createLoadBalancers>;
}): hcloud.Server[] {
  if (serverCount < 1) {
    return [];
  }

  const servers: hcloud.Server[] = [];
  const nodeResourceName = NODE_RESOURCE_NAMES[type];

  const placementGroups =
    type === 'control-plane'
      ? [
          new hcloud.PlacementGroup('HetznerControlPlanePlacementGroup', {
            name: 'control-plane',
            type: 'spread'
          })
        ]
      : Array.from({ length: Math.ceil(serverCount / 10) }).map((_, i) => {
          return new hcloud.PlacementGroup(`Hetzner${nodeResourceName}PlacementGroup${i}`, {
            name: `${type}s-${i}`,
            type: 'spread'
          });
        });

  for (let i = 0; i < serverCount; i++) {
    const { userData, tailscaleHostname } = createNodeUserData({
      provider: 'hetzner',
      type,
      index: i,
      privateInterface: PRIVATE_INTERFACE,
      privateNetplan: ''
    });

    const dependencies = [bootstrapServer, servers.at(-1) ?? previousServer].filter(
      (resource) => resource !== undefined
    );

    const server = new hcloud.Server(
      `Hetzner${nodeResourceName}Server${i}`,
      {
        name: `${STAGE_NAME}-${type}-server-${i}`,
        serverType: SERVER_TYPE,
        image: SERVER_IMAGE,
        location: LOCATION,
        placementGroupId: placementGroups[Math.floor(i / 10)].id.apply((id) => parseInt(id)),
        deleteProtection: isProduction,
        rebuildProtection: isProduction,
        firewallIds: firewalls.map((firewall) => firewall.id.apply((id) => parseInt(id))),
        networks: [
          {
            networkId: network.network.id.apply((id) => parseInt(id)),
            ip: getNodeIp({ type, index: i })
          }
        ],
        publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
        shutdownBeforeDeletion: true,
        labels: { tailscale: tailscaleHostname },
        userData
      },
      {
        dependsOn: dependencies,
        ignoreChanges: isProduction ? ['userData'] : [],
        protect: isProduction,
        hooks: {
          afterDelete: [deleteServerFromTailnet]
        }
      }
    );
    servers.push(server);
  }

  if (type === 'database') {
    return servers;
  }
  for (const [index, server] of servers.entries()) {
    const groupIndex = Math.floor(index / 25);
    for (let j = 0; j < LOAD_BALANCERS_PER_NODE; j++) {
      const loadBalancerIndex = groupIndex * LOAD_BALANCERS_PER_NODE + j;
      const { loadbalancer, network } = loadBalancers[loadBalancerIndex];
      new hcloud.LoadBalancerTarget(
        `HetznerK3s${nodeResourceName}LoadBalancer${loadBalancerIndex}Target${index}`,
        {
          loadBalancerId: loadbalancer.id.apply((id) => parseInt(id)),
          type: 'server',
          serverId: server.id.apply((id) => parseInt(id)),
          usePrivateIp: true
        },
        { dependsOn: [network] }
      );
    }
  }

  return servers;
}
