import { isProduction, STAGE_NAME } from '../dns';
import { createLoadBalancers } from './load-balancers';
import {
  createNodeUserData,
  createTailnetCleanupHook,
  getClusterNodes,
  getPoolResourceName,
  PRIVATE_IP_RANGE,
  type ClusterNode,
  type NodePool
} from './servers';

// NOTE: a server type like cx23 or ccx13. Servers can only be upgraded, not downgraded, because
// disk size needs to be >= than the previous type
export type HetznerServer = string;

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
export function createHetznerCluster(pools: NodePool<HetznerServer>[]) {
  const nodes = getClusterNodes({ provider: 'hetzner', pools });

  const privateNetwork = new hcloud.Network('HetznerK3sPrivateNetwork', {
    name: `k3s-private-${STAGE_NAME}-network`,
    ipRange: '10.0.0.0/8'
  });
  // NOTE: Hetzner rejects overlapping subnets, so a new range must replace the old one in place
  const subnet = new hcloud.NetworkSubnet(
    'HetznerK3sSubnet',
    {
      networkId: privateNetwork.id.apply((id) => parseInt(id)),
      type: 'cloud',
      ipRange: PRIVATE_IP_RANGE,
      networkZone: NETWORK_ZONE
    },
    { deleteBeforeReplace: true }
  );
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

  const placementGroups = new Map<string, hcloud.PlacementGroup>();
  const nodeServers: { node: ClusterNode<HetznerServer>; server: hcloud.Server }[] = [];
  for (const node of nodes) {
    // NOTE: a spread placement group holds up to 10 servers
    const placementGroupIndex = Math.floor(node.index / 10);
    const placementGroupName = `${node.pool.name}-${placementGroupIndex}`;
    const placementGroup =
      placementGroups.get(placementGroupName) ??
      new hcloud.PlacementGroup(
        `Hetzner${getPoolResourceName(node.pool)}PlacementGroup${placementGroupIndex}`,
        { name: placementGroupName, type: 'spread' }
      );
    placementGroups.set(placementGroupName, placementGroup);

    const userData = createNodeUserData({
      provider: 'hetzner',
      node,
      privateInterface: PRIVATE_INTERFACE,
      privateNetplan: ''
    });
    const server = new hcloud.Server(
      `Hetzner${node.resourceName}`,
      {
        name: node.hostname,
        serverType: node.pool.server,
        image: SERVER_IMAGE,
        location: LOCATION,
        placementGroupId: placementGroup.id.apply((id) => parseInt(id)),
        deleteProtection: isProduction,
        rebuildProtection: isProduction,
        firewallIds: [inboundFirewall.id.apply((id) => parseInt(id))],
        networks: [{ networkId: privateNetwork.id.apply((id) => parseInt(id)), ip: node.ip }],
        publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
        shutdownBeforeDeletion: true,
        labels: { tailscale: node.hostname },
        userData
      },
      {
        dependsOn: [subnet, nodeServers[0]?.server, nodeServers.at(-1)?.server].filter(
          (dependency) => dependency !== undefined
        ),
        ignoreChanges: isProduction ? ['userData'] : [],
        protect: isProduction,
        hooks: {
          afterDelete: [deleteServerFromTailnet]
        }
      }
    );
    nodeServers.push({ node, server });
  }

  // NOTE: tainted worker pools, like databases, take no load balancer traffic
  const loadBalancedServers = {
    'control-plane': nodeServers.filter(({ node }) => node.pool.role === 'control-plane'),
    worker: nodeServers.filter(
      ({ node }) => node.pool.role === 'worker' && !node.pool.taints?.length
    )
  };
  const [controlPlaneLoadBalancers, workerLoadBalancers] = (
    ['control-plane', 'worker'] as const
  ).map((type) => {
    const loadBalancers = createLoadBalancers(
      {
        type,
        loadBalancerCount:
          Math.ceil(loadBalancedServers[type].length / loadBalancerServerCapacity) *
          LOAD_BALANCERS_PER_NODE,
        network: privateNetwork
      },
      { type: LOAD_BALANCER_TYPE, location: LOCATION, algorithm: LOAD_BALANCER_ALGORITHM }
    );
    for (const [index, { node, server }] of loadBalancedServers[type].entries()) {
      const groupIndex = Math.floor(index / loadBalancerServerCapacity);
      for (let j = 0; j < LOAD_BALANCERS_PER_NODE; j++) {
        const loadBalancerIndex = groupIndex * LOAD_BALANCERS_PER_NODE + j;
        const { loadbalancer, network } = loadBalancers[loadBalancerIndex];
        new hcloud.LoadBalancerTarget(
          `HetznerK3s${node.resourceName}LoadBalancer${loadBalancerIndex}Target`,
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
    return loadBalancers;
  });

  return { controlPlaneLoadBalancers, workerLoadBalancers };
}
