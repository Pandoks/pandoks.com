import { STAGE_NAME, isProduction } from '../utils';
import { createOvhCloudProject, getFlavorId, getImageId, getLoadBalancerFlavorId } from '../ovh';
import { deleteTailscaleDevices } from '../tailscale';
import { createClusterLoadBalancers } from './load-balancers';
import { createClusterNetwork } from './network';
import { createDedicatedNode } from './providers/dedicated';
import { createPublicCloudNode, type ClusterNode } from './providers/public-cloud';
import { NON_PRODUCTION_CLUSTER_CONFIG, PRODUCTION_CLUSTER_CONFIG } from './config';
import {
  CLUSTER_NETWORK_CIDR,
  normalizeNodePools,
  type NodePool,
  type PublicCloudNodePool
} from './types';

const REGION = 'US-WEST-OR-1';
const GATEWAY_MODEL = 's';
const LOAD_BALANCER_FLAVOR = 'small';
const LOAD_BALANCER_ALGORITHM = 'leastConnections';
export const clusterConfig = isProduction
  ? PRODUCTION_CLUSTER_CONFIG
  : NON_PRODUCTION_CLUSTER_CONFIG;
export const clusterNodeCount =
  clusterConfig.cloudControlPlaneCount +
  clusterConfig.cloudWorkerCount +
  clusterConfig.dedicatedControlPlaneCount +
  clusterConfig.dedicatedWorkerCount;
export const shouldProvisionClusterInfrastructure = isProduction || clusterNodeCount > 0;

const NODE_POOLS: readonly NodePool[] = [
  {
    name: 'cloud-control-plane',
    provider: 'public-cloud',
    role: 'control-plane',
    count: clusterConfig.cloudControlPlaneCount,
    ingress: true,
    flavor: 'b3-8',
    image: 'Ubuntu 24.04',
    region: REGION
  },
  {
    name: 'cloud-workers',
    provider: 'public-cloud',
    role: 'worker',
    count: clusterConfig.cloudWorkerCount,
    ingress: true,
    flavor: 'b3-8',
    image: 'Ubuntu 24.04',
    region: REGION
  },
  {
    name: 'dedicated-control-plane',
    provider: 'dedicated',
    role: 'control-plane',
    count: clusterConfig.dedicatedControlPlaneCount,
    ingress: true,
    plan: clusterConfig.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: clusterConfig.dedicatedDatacenter,
    orderRegion: clusterConfig.dedicatedOrderRegion,
    planOptions: clusterConfig.dedicatedPlanOptions
  },
  {
    name: 'dedicated-workers',
    provider: 'dedicated',
    role: 'worker',
    count: clusterConfig.dedicatedWorkerCount,
    ingress: true,
    plan: clusterConfig.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: clusterConfig.dedicatedDatacenter,
    orderRegion: clusterConfig.dedicatedOrderRegion,
    planOptions: clusterConfig.dedicatedPlanOptions
  }
];

const topology = normalizeNodePools(NODE_POOLS, STAGE_NAME, CLUSTER_NETWORK_CIDR);
for (const warning of topology.warnings) {
  console.warn(warning);
}

const cloudProject = shouldProvisionClusterInfrastructure
  ? createOvhCloudProject({
      stageName: STAGE_NAME,
      protect: isProduction
    })
  : undefined;
const network = cloudProject
  ? createClusterNetwork({
      serviceName: cloudProject.projectId,
      region: REGION,
      cidr: CLUSTER_NETWORK_CIDR,
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
