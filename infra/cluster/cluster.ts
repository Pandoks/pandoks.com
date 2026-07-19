import { isProduction, STAGE_NAME } from '../dns';
import { getFlavorId, getImageId, getLoadBalancerFlavorId } from '../ovh';
import { deleteTailscaleDevices } from '../tailscale';
import { createClusterLoadBalancers } from './load-balancers';
import { createClusterNetwork } from './network';
import { createDedicatedNode } from './providers/dedicated';
import { createPublicCloudNode, type ClusterNode } from './providers/public-cloud';
import { getClusterStageConfig } from './config';
import {
  getUnprotectedNodeWarning,
  isClusterNodeProtected,
  CLUSTER_ADDRESS_PLAN,
  normalizeNodePools,
  type NodePool,
  type PublicCloudNodePool
} from './types';

const REGION = 'US-WEST-OR-1';
const NETWORK_CIDR = '10.0.1.0/24';
const GATEWAY_MODEL = 's';
const LOAD_BALANCER_FLAVOR = 'small';
const LOAD_BALANCER_ALGORITHM = 'leastConnections';
const UNPROTECTED_NODE_LOGICAL_NAME = process.env.OVH_UNPROTECTED_NODE_LOGICAL_NAME?.trim() ?? '';
const CLUSTER_CONFIG = getClusterStageConfig(isProduction);

const NODE_POOLS: readonly NodePool[] = [
  {
    name: 'cloud-control-plane',
    provider: 'public-cloud',
    role: 'control-plane',
    count: CLUSTER_CONFIG.cloudControlPlaneCount,
    ingress: true,
    privateIpStart: CLUSTER_ADDRESS_PLAN['cloud-control-plane'].start,
    flavor: 'b3-8',
    image: 'Ubuntu 24.04',
    region: REGION
  },
  {
    name: 'cloud-workers',
    provider: 'public-cloud',
    role: 'worker',
    count: CLUSTER_CONFIG.cloudWorkerCount,
    ingress: true,
    privateIpStart: CLUSTER_ADDRESS_PLAN['cloud-workers'].start,
    flavor: 'b3-8',
    image: 'Ubuntu 24.04',
    region: REGION
  },
  {
    name: 'dedicated-control-plane',
    provider: 'dedicated',
    role: 'control-plane',
    count: CLUSTER_CONFIG.dedicatedControlPlaneCount,
    ingress: true,
    privateIpStart: CLUSTER_ADDRESS_PLAN['dedicated-control-plane'].start,
    plan: CLUSTER_CONFIG.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: CLUSTER_CONFIG.dedicatedDatacenter,
    orderRegion: CLUSTER_CONFIG.dedicatedOrderRegion,
    planOptions: CLUSTER_CONFIG.dedicatedPlanOptions
  },
  {
    name: 'dedicated-workers',
    provider: 'dedicated',
    role: 'worker',
    count: CLUSTER_CONFIG.dedicatedWorkerCount,
    ingress: true,
    privateIpStart: CLUSTER_ADDRESS_PLAN['dedicated-workers'].start,
    plan: CLUSTER_CONFIG.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: CLUSTER_CONFIG.dedicatedDatacenter,
    orderRegion: CLUSTER_CONFIG.dedicatedOrderRegion,
    planOptions: CLUSTER_CONFIG.dedicatedPlanOptions
  }
];

const topology = normalizeNodePools(NODE_POOLS, STAGE_NAME, NETWORK_CIDR);
for (const warning of topology.warnings) {
  console.warn(warning);
}
const unprotectedNodeWarning = getUnprotectedNodeWarning(
  topology.nodes,
  UNPROTECTED_NODE_LOGICAL_NAME
);
if (unprotectedNodeWarning) {
  console.warn(unprotectedNodeWarning);
}

const network = createClusterNetwork({
  region: REGION,
  cidr: NETWORK_CIDR,
  gatewayModel: GATEWAY_MODEL
});

const loadBalancerFlavorId = topology.nodes.length
  ? await getLoadBalancerFlavorId(REGION, LOAD_BALANCER_FLAVOR)
  : '';
const loadBalancers = createClusterLoadBalancers({
  nodes: topology.nodes,
  network,
  region: REGION,
  flavorId: loadBalancerFlavorId,
  algorithm: LOAD_BALANCER_ALGORITHM
});

if (topology.nodes.length > 0 && !loadBalancers.apiAddress) {
  throw new Error('A non-empty cluster requires the private API load balancer');
}

const apiAddress = loadBalancers.apiAddress ?? $output('');
const publicCloudPools = NODE_POOLS.filter(
  (pool): pool is PublicCloudNodePool => pool.provider === 'public-cloud'
);
const publicCloudCatalog = new Map<string, { flavorId: string; imageId: string }>();
for (const pool of publicCloudPools) {
  if (pool.count > 0) {
    publicCloudCatalog.set(pool.name, {
      flavorId: await getFlavorId(pool.region, pool.flavor),
      imageId: await getImageId(pool.region, pool.image)
    });
  }
}

export const clusterNodes: ClusterNode[] = topology.nodes.map((spec) => {
  if (spec.pool.provider === 'public-cloud') {
    const catalog = publicCloudCatalog.get(spec.pool.name);
    if (!catalog) {
      throw new Error(`Missing Public Cloud catalog for ${spec.pool.name}`);
    }
    return createPublicCloudNode({
      spec: {
        ...spec,
        pool: spec.pool
      },
      network,
      apiAddress,
      protect: isClusterNodeProtected(spec, UNPROTECTED_NODE_LOGICAL_NAME, isProduction),
      ...catalog
    });
  }
  return createDedicatedNode({
    spec: {
      ...spec,
      pool: spec.pool
    },
    network,
    apiAddress,
    protect: isClusterNodeProtected(spec, UNPROTECTED_NODE_LOGICAL_NAME, isProduction)
  });
});

if (clusterNodes.length === 0) {
  const devices = await tailscale.getDevices({ namePrefix: STAGE_NAME });
  const stale = devices.devices.filter(
    (device) =>
      device.tags.includes('tag:ovh') &&
      device.tags.includes(`tag:${STAGE_NAME}`) &&
      (device.tags.includes('tag:control-plane') || device.tags.includes('tag:worker'))
  );
  if (stale.length) {
    deleteTailscaleDevices(...stale.map((device) => device.nodeId));
  }
}

export const publicIngressLoadBalancers = loadBalancers.publicIngress;
export const outputs = Object.fromEntries(
  publicIngressLoadBalancers.map((loadBalancer, index): [string, $util.Output<string>] => [
    `IngressLoadBalancer${index}`,
    loadBalancer.floatingIp.apply((floatingIp) => floatingIp.ip)
  ])
);
