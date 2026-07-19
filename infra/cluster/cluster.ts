import { STAGE_NAME, isProduction } from '../utils';
import { createOvhCloudProject, getFlavorId, getImageId, getLoadBalancerFlavorId } from '../ovh';
import { deleteTailscaleDevices } from '../tailscale';
import { createClusterLoadBalancers } from './load-balancers';
import { createClusterNetwork } from './network';
import { createDedicatedNode } from './providers/dedicated';
import { createPublicCloudNode, type ClusterNode } from './providers/public-cloud';
import {
  GATEWAY_MODEL,
  LOAD_BALANCER_ALGORITHM,
  LOAD_BALANCER_FLAVOR,
  NODE_POOLS,
  REGION,
  clusterNodeCount
} from './config';
import { CLUSTER_NETWORK_CIDR, normalizeNodePools, type PublicCloudNodePool } from './types';

const topology = normalizeNodePools(NODE_POOLS, STAGE_NAME, CLUSTER_NETWORK_CIDR);
for (const warning of topology.warnings) {
  console.warn(warning);
}

const cloudProject = createOvhCloudProject({
  stageName: STAGE_NAME,
  protect: isProduction
});
const network =
  clusterNodeCount > 0
    ? createClusterNetwork({
        serviceName: cloudProject.projectId,
        region: REGION,
        cidr: CLUSTER_NETWORK_CIDR,
        gatewayModel: GATEWAY_MODEL
      })
    : undefined;

const loadBalancerFlavorId = topology.nodes.length
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
  CloudProjectId: cloudProject.projectId,
  ...Object.fromEntries(
    publicIngressLoadBalancers.map((loadBalancer, index): [string, $util.Output<string>] => [
      `IngressLoadBalancer${index}`,
      loadBalancer.floatingIp.apply((floatingIp) => floatingIp.ip)
    ])
  )
};
