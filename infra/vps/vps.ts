// WARNING: resources that hold data like servers, volumes, etc. should be protected by the
// `protect` option in production. This is to prevent accidental deletion of resources.
import { isProduction, STAGE_NAME } from '../dns';
import { createServers } from './servers';
import { createLoadBalancers } from './load-balancers';

// NOTE: if you want to downsize the cluster, remember to manually drain remove the nodes with `kubectl drain` & `kubectl delete node`
const CONTROL_PLANE_NODE_COUNT = isProduction ? 1 : 1;
const CONTROL_PLANE_HOST_START_OCTET = 10; // starts at 10.0.1.<CONTROL_PLANE_HOST_START_OCTET>
const WORKER_NODE_COUNT = isProduction ? 0 : 0;
const WORKER_HOST_START_OCTET = 20; // starts at 10.0.1.<WORKER_HOST_START_OCTET> 20 allows for 10 control plane nodes
// NOTE: servers can only be upgraded, not downgraded because disk size needs to be >= than the previous type
const SERVER_TYPE = isProduction ? 'ccx13' : 'cx23';
const LOAD_BALANCER_COUNT = isProduction ? 1 : 0;
const LOAD_BALANCER_TYPE = isProduction ? 'lb11' : 'lb11';
const LOAD_BALANCER_ALGORITHM = 'least_connections'; // round_robin, least_connections
const SERVER_IMAGE = 'ubuntu-24.04';
const LOCATION = isProduction ? 'hil' : 'fsn1';
const NETWORK_ZONE = isProduction ? 'us-west' : 'eu-central';

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
  networkZone: NETWORK_ZONE
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

const publicLoadBalancers = createLoadBalancers(
  {
    controlPlaneCount: CONTROL_PLANE_NODE_COUNT,
    workerNodeCount: WORKER_NODE_COUNT,
    loadBalancerCount: LOAD_BALANCER_COUNT,
    network: privateNetwork
  },
  {
    type: LOAD_BALANCER_TYPE,
    location: LOCATION,
    alogrithm: LOAD_BALANCER_ALGORITHM
  }
);

let bootstrapServer: { ip: $util.Output<string> | undefined; server: hcloud.Server | undefined } = {
  ip: undefined,
  server: undefined
};

const { tailscaleHostnames: controlPlaneTailscaleHostnames, servers: controlPlaneServers } =
  createServers(
    {
      type: 'control-plane',
      serverCount: CONTROL_PLANE_NODE_COUNT,
      network: { network: privateNetwork, subnet },
      startingOctet: CONTROL_PLANE_HOST_START_OCTET,
      loadBalancers: publicLoadBalancers
    },
    {
      type: SERVER_TYPE,
      image: SERVER_IMAGE,
      location: LOCATION,
      firewalls: [firewall]
    },
    bootstrapServer
  );
const { tailscaleHostnames: workerTailscaleHostnames, servers: workerServers } = createServers(
  {
    type: 'worker',
    serverCount: WORKER_NODE_COUNT,
    network: { network: privateNetwork, subnet },
    startingOctet: WORKER_HOST_START_OCTET,
    loadBalancers: publicLoadBalancers
  },
  {
    type: SERVER_TYPE,
    image: SERVER_IMAGE,
    location: LOCATION,
    firewalls: [firewall]
  },
  bootstrapServer
);

const publicLoadBalancerOutputs = Object.fromEntries(
  publicLoadBalancers.map((loadbalancer) => [
    loadbalancer.loadbalancer.name,
    loadbalancer.loadbalancer.ipv4
  ])
);

export const outputs = { ...publicLoadBalancerOutputs };

export { publicLoadBalancers };
