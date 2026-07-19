import { isProduction, STAGE_NAME } from '../dns';
import { createOvhCloudProject, getFlavorId, getImageId, getLoadBalancerFlavorId } from '../ovh';
import { deleteTailscaleDevices } from '../tailscale';
import { createClusterLoadBalancers } from './load-balancers';
import { createClusterNetwork } from './network';
import { createDedicatedNode } from './providers/dedicated';
import { createPublicCloudNode, type ClusterNode } from './providers/public-cloud';
import { getClusterStageConfig, shouldProvisionClusterInfrastructure } from './config';
import {
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
const CLUSTER_CONFIG = getClusterStageConfig(isProduction);
const provisionClusterInfrastructure = shouldProvisionClusterInfrastructure(
  isProduction,
  CLUSTER_CONFIG
);

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

const cloudProject = provisionClusterInfrastructure
  ? createOvhCloudProject({
      stageName: STAGE_NAME,
      protect: isProduction
    })
  : undefined;
const network = cloudProject
  ? createClusterNetwork({
      serviceName: cloudProject.projectId,
      region: REGION,
      cidr: NETWORK_CIDR,
      gatewayModel: GATEWAY_MODEL
    })
  : undefined;

const loadBalancerFlavorId =
  topology.nodes.length && cloudProject
    ? getLoadBalancerFlavorId(cloudProject.projectId, REGION, LOAD_BALANCER_FLAVOR)
    : '';
const loadBalancers = network
  ? createClusterLoadBalancers({
      nodes: topology.nodes,
      network,
      region: REGION,
      flavorId: loadBalancerFlavorId,
      algorithm: LOAD_BALANCER_ALGORITHM
    })
  : {
      api: undefined,
      apiAddress: undefined,
      publicIngress: []
    };

if (topology.nodes.length > 0 && !loadBalancers.apiAddress) {
  throw new Error('A non-empty cluster requires the private API load balancer');
}

const apiAddress = loadBalancers.apiAddress ?? $output('');
const publicCloudPools = NODE_POOLS.filter(
  (pool): pool is PublicCloudNodePool => pool.provider === 'public-cloud'
);
const publicCloudCatalog = new Map<
  string,
  { flavorId: $util.Input<string>; imageId: $util.Input<string> }
>();
for (const pool of publicCloudPools) {
  if (pool.count > 0) {
    if (!cloudProject) {
      throw new Error('Public Cloud nodes require the managed Public Cloud project');
    }
    publicCloudCatalog.set(pool.name, {
      flavorId: getFlavorId(cloudProject.projectId, pool.region, pool.flavor),
      imageId: getImageId(cloudProject.projectId, pool.region, pool.image)
    });
  }
}

export const clusterNodes: ClusterNode[] = topology.nodes.map((spec) => {
  if (!network) {
    throw new Error('A non-empty cluster requires shared cluster infrastructure');
  }
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
      protect: isProduction,
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
    protect: isProduction
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
export const outputs = {
  CloudProjectId: cloudProject?.projectId ?? '',
  ...Object.fromEntries(
    publicIngressLoadBalancers.map((loadBalancer, index): [string, $util.Output<string>] => [
      `IngressLoadBalancer${index}`,
      loadBalancer.floatingIp.apply((floatingIp) => floatingIp.ip)
    ])
  )
};
