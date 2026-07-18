// WARNING: resources that hold data like servers, volumes, etc. should be protected by the
// `protect` option in production. This is to prevent accidental deletion of resources.
import { isProduction, STAGE_NAME } from '../dns';
import {
  getFlavorId,
  getImageId,
  getLoadBalancerFlavorId,
  OVH_CLOUD_PROJECT_SERVICE
} from '../ovh';
import { createServers } from './servers';
import { createLoadBalancers } from './load-balancers';
import { deleteTailscaleDevices } from '../tailscale';

// NOTE: if you want to downsize the cluster, remember to manually drain remove the nodes with `kubectl drain` & `kubectl delete node`
const CONTROL_PLANE_NODE_COUNT = isProduction ? 0 : 0;
const CONTROL_PLANE_HOST_START_OCTET = 10; // starts at 10.0.1.<CONTROL_PLANE_HOST_START_OCTET>
const WORKER_NODE_COUNT = isProduction ? 0 : 0;
const WORKER_HOST_START_OCTET = 20; // starts at 10.0.1.<WORKER_HOST_START_OCTET> 20 allows for 10 control plane nodes
// NOTE: instances can't be resized in place. changing the flavor recreates the server, so drain first
const SERVER_FLAVOR = isProduction ? 'b3-8' : 'd2-4';
const LOAD_BALANCERS_PER_NODE = isProduction ? 1 : 0;
const LOAD_BALANCER_FLAVOR = 'small';
const LOAD_BALANCER_ALGORITHM = 'leastConnections'; // roundRobin, leastConnections, sourceIp
const SERVER_IMAGE = 'Ubuntu 24.04';
// NOTE: US regions need an OVHcloud US account (ovh-us endpoint). swap for DE1/GRA + ovh-eu if the
// account is an OVHcloud EU one
const REGION = isProduction ? 'US-WEST-OR-1' : 'US-EAST-VA-1';
const NETWORK_CIDR = '10.0.1.0/24';
const GATEWAY_MODEL = 's';

const loadBalancerServerCapacity = 25;

/**
 * NOTE: The cluster stays in a single region on purpose. OVH private networks can span regions, but
 * cross-region traffic adds latency and the load balancers are regional anyways. If you want to have
 * multiple regions to reduce latency, create a cluster per region.
 *
 * To have multiple regions work, look into Cloudflare DNS load balancers. You can steer traffic based
 * off of "geo steering" or "proximity/latency". This costs extra, so stay in one region until latency
 * is an issue.
 *
 * You'll probably want to rename a bunch of the resources and variable names when you do.
 */
const privateNetwork = new ovh.cloudproject.NetworkPrivate('OvhK3sPrivateNetwork', {
  serviceName: OVH_CLOUD_PROJECT_SERVICE,
  name: `k3s-private-${STAGE_NAME}-network`,
  regions: [REGION]
});
const subnetPrefix = NETWORK_CIDR.split('.').slice(0, 3).join('.');
const subnet = new ovh.cloudproject.NetworkPrivateSubnet('OvhK3sSubnet', {
  serviceName: OVH_CLOUD_PROJECT_SERVICE,
  networkId: privateNetwork.id,
  region: REGION,
  network: NETWORK_CIDR,
  start: `${subnetPrefix}.2`,
  end: `${subnetPrefix}.254`,
  // NOTE: dhcp hands each instance its neutron fixed ip. without it the private interface never
  // gets configured inside the guest
  dhcp: true
});
const openstackNetworkId = privateNetwork.regionsAttributes.apply((regionsAttributes) => {
  const regionAttributes = regionsAttributes.find((attributes) => attributes.region === REGION);
  if (!regionAttributes) {
    throw new Error(`Private network is missing region ${REGION}`);
  }
  return regionAttributes.openstackid;
});

const totalNodeCount = CONTROL_PLANE_NODE_COUNT + WORKER_NODE_COUNT;
const serverFlavorId = totalNodeCount ? await getFlavorId(REGION, SERVER_FLAVOR) : '';
const serverImageId = totalNodeCount ? await getImageId(REGION, SERVER_IMAGE) : '';

const controlPlaneIps = Array.from({ length: CONTROL_PLANE_NODE_COUNT }).map(
  (_, i) => `${subnetPrefix}.${CONTROL_PLANE_HOST_START_OCTET + i}`
);
const workerIps = Array.from({ length: WORKER_NODE_COUNT }).map(
  (_, i) => `${subnetPrefix}.${WORKER_HOST_START_OCTET + i}`
);

const controlPlaneLoadBalancerCount =
  Math.ceil(CONTROL_PLANE_NODE_COUNT / loadBalancerServerCapacity) * LOAD_BALANCERS_PER_NODE;
const workerLoadBalancerCount =
  Math.ceil(WORKER_NODE_COUNT / loadBalancerServerCapacity) * LOAD_BALANCERS_PER_NODE;
const totalLoadBalancerCount = controlPlaneLoadBalancerCount + workerLoadBalancerCount;

const loadBalancerFlavorId = totalLoadBalancerCount
  ? await getLoadBalancerFlavorId(REGION, LOAD_BALANCER_FLAVOR)
  : '';
// NOTE: the load balancers' public floating ips need a gateway on the private network
const gateway = totalLoadBalancerCount
  ? new ovh.cloudproject.Gateway('OvhK3sGateway', {
      serviceName: OVH_CLOUD_PROJECT_SERVICE,
      name: `k3s-${STAGE_NAME}-gateway`,
      model: GATEWAY_MODEL,
      region: REGION,
      networkId: openstackNetworkId,
      subnetId: subnet.id
    })
  : undefined;

export const controlPlaneLoadBalancers = createLoadBalancers(
  {
    type: 'control-plane',
    loadBalancerCount: controlPlaneLoadBalancerCount,
    loadBalancersPerNode: LOAD_BALANCERS_PER_NODE,
    serverIps: controlPlaneIps,
    serversPerLoadBalancer: loadBalancerServerCapacity,
    network: { networkId: openstackNetworkId, subnetId: subnet.id },
    gateway
  },
  {
    flavorId: loadBalancerFlavorId,
    region: REGION,
    algorithm: LOAD_BALANCER_ALGORITHM
  }
);

export const workerLoadBalancers = createLoadBalancers(
  {
    type: 'worker',
    loadBalancerCount: workerLoadBalancerCount,
    loadBalancersPerNode: LOAD_BALANCERS_PER_NODE,
    serverIps: workerIps,
    serversPerLoadBalancer: loadBalancerServerCapacity,
    network: { networkId: openstackNetworkId, subnetId: subnet.id },
    gateway
  },
  {
    flavorId: loadBalancerFlavorId,
    region: REGION,
    algorithm: LOAD_BALANCER_ALGORITHM
  }
);

const bootstrapServer: { ip: string | undefined; server: ovh.cloudproject.Instance | undefined } = {
  ip: undefined,
  server: undefined
};

const { tailscaleHostnames: _controlPlaneTailscaleHostnames, servers: _controlPlaneServers } =
  createServers(
    {
      type: 'control-plane',
      serverCount: CONTROL_PLANE_NODE_COUNT,
      ips: controlPlaneIps,
      network: { networkId: openstackNetworkId, subnetId: subnet.id, cidr: NETWORK_CIDR }
    },
    {
      flavorId: serverFlavorId,
      imageId: serverImageId,
      region: REGION
    },
    bootstrapServer
  );
const { tailscaleHostnames: _workerTailscaleHostnames, servers: _workerServers } = createServers(
  {
    type: 'worker',
    serverCount: WORKER_NODE_COUNT,
    ips: workerIps,
    network: { networkId: openstackNetworkId, subnetId: subnet.id, cidr: NETWORK_CIDR }
  },
  {
    flavorId: serverFlavorId,
    imageId: serverImageId,
    region: REGION
  },
  bootstrapServer
);

if (CONTROL_PLANE_NODE_COUNT + WORKER_NODE_COUNT === 0) {
  const devices = await tailscale.getDevices({ namePrefix: `${STAGE_NAME}` });

  const kubernetesDevices = devices.devices.filter(
    (device) => device.tags.includes('tag:k8s') && device.tags.includes(`tag:${STAGE_NAME}`)
  );
  if (kubernetesDevices.length > 0) {
    const deletedDevices = deleteTailscaleDevices(
      ...kubernetesDevices.map((device) => device.nodeId)
    );
    deletedDevices.apply((deletedDevices) => {
      const deletedDeviceIds = deletedDevices
        .filter((device) => device.success)
        .map((device) => device.deviceId);
      const failedToDeleteDeviceIds = deletedDevices
        .filter((device) => !device.success)
        .map((device) => device.deviceId);
      if (deletedDeviceIds.length) {
        console.log(
          `Deleted Tailscale devices:\n${kubernetesDevices
            .filter((device) => deletedDeviceIds.includes(device.nodeId))
            .map((device) => device.name)
            .join('\n')}`
        );
      }
      if (failedToDeleteDeviceIds.length) {
        console.log(
          `Failed to delete Tailscale devices:\n${kubernetesDevices
            .filter((device) => failedToDeleteDeviceIds.includes(device.nodeId))
            .map((device) => device.name)
            .join('\n')}`
        );
      }
    });
  }
}

const publicLoadBalancerOutputs = Object.fromEntries(
  // NOTE: we have to hard code the name because indecies can't be pulumi inputs/outputs
  [
    ...controlPlaneLoadBalancers.map((lb, i): [string, $util.Output<string>] => [
      `ControlPlaneLoadBalancer${i}`,
      lb.floatingIp.apply((floatingIp) => floatingIp.ip)
    ]),
    ...workerLoadBalancers.map((lb, i): [string, $util.Output<string>] => [
      `WorkerLoadBalancer${i}`,
      lb.floatingIp.apply((floatingIp) => floatingIp.ip)
    ])
  ]
);

export const outputs = { ...publicLoadBalancerOutputs };
