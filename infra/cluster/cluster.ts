import { STAGE_NAME, isProduction } from '../utils';
import { deleteTailscaleDevices } from '../tailscale';
import { NODE_POOLS } from './config';
import { createClusterLoadBalancers } from './load-balancers';
import { createClusterNetwork } from './network';
import { createDedicatedNodes } from './providers/dedicated';
import { createPublicCloudNodes } from './providers/public-cloud';
import { buildClusterPlan } from './topology';

const topology = buildClusterPlan(NODE_POOLS, STAGE_NAME);
for (const warning of topology.warnings) console.warn(warning);

const cloudProject = new ovh.cloudproject.Project(
  'OvhPublicCloudProject',
  {
    deletionProtection: isProduction,
    description: `${STAGE_NAME.capitalize()} Public Cloud project`,
    ovhSubsidiary: 'US',
    plan: {
      duration: 'P1M',
      planCode: 'project',
      pricingMode: 'default'
    }
  },
  { protect: isProduction }
);

const network =
  topology.nodes.length > 0 ? createClusterNetwork(cloudProject.projectId) : undefined;
const loadBalancers = network && createClusterLoadBalancers({ nodes: topology.nodes, network });

if (network && loadBalancers) {
  for (const pool of NODE_POOLS) {
    const nodes = topology.nodes.filter((node) => node.pool === pool);
    if (nodes.length === 0) continue;
    const args = {
      nodes,
      network,
      apiAddress: loadBalancers.apiAddress,
      protect: isProduction
    };
    if (pool.provider === 'public-cloud') {
      createPublicCloudNodes({ ...args, pool });
    } else {
      createDedicatedNodes({ ...args, pool });
    }
  }
}

if (topology.nodes.length === 0) {
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

export const publicIngressLoadBalancer = loadBalancers?.publicIngress;
export const outputs = {
  CloudProjectId: cloudProject.projectId,
  ...(publicIngressLoadBalancer && {
    IngressLoadBalancer: publicIngressLoadBalancer.floatingIp.apply((floatingIp) => floatingIp.ip)
  })
};
