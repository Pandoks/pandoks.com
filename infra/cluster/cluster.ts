import { cloudflareZoneId } from '../dns';
import { deleteTailscaleDevices } from '../tailscale';
import { K3S_API_HOSTNAME, STAGE_NAME, isProduction } from '../utils';
import { NODE_POOLS, clusterConfig } from './config';
import { createClusterLoadBalancers } from './load-balancers';
import { createClusterNetwork } from './network';
import { createDedicatedNodes } from './providers/dedicated';
import { createPublicCloudNodes } from './providers/public-cloud';
import { buildClusterPlan } from './topology';

const topology = buildClusterPlan(NODE_POOLS, STAGE_NAME, clusterConfig.loadBalancerCount);
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
const loadBalancers =
  network &&
  createClusterLoadBalancers({
    network,
    privateApi: topology.privateApi,
    publicIngress: topology.publicIngress
  });
const privateApiDnsRecord =
  loadBalancers &&
  new cloudflare.DnsRecord('OvhK3sPrivateApiDnsRecord', {
    name: K3S_API_HOSTNAME,
    zoneId: cloudflareZoneId,
    type: 'A',
    content: loadBalancers.apiTarget,
    proxied: false,
    ttl: 60,
    comment: 'private ovh k3s api'
  });
const privateApiHostname = privateApiDnsRecord
  ? privateApiDnsRecord.id.apply(() => K3S_API_HOSTNAME)
  : undefined;

const provisionedNodes: Array<{
  node: (typeof topology.nodes)[number];
  publicIp: $util.Output<string>;
}> = [];

if (network && loadBalancers && privateApiHostname) {
  for (const pool of NODE_POOLS) {
    const nodes = topology.nodes.filter((node) => node.pool === pool);
    if (nodes.length === 0) continue;
    const args = {
      nodes,
      network,
      apiAddress: privateApiHostname,
      protect: isProduction
    };
    if (pool.provider === 'public-cloud') {
      provisionedNodes.push(...createPublicCloudNodes({ ...args, pool }));
    } else {
      provisionedNodes.push(...createDedicatedNodes({ ...args, pool }));
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

export const publicIngress = (() => {
  if (!loadBalancers || topology.publicIngress.mode === 'none') return;
  if (topology.publicIngress.mode === 'direct') {
    const target = provisionedNodes.find(({ node }) => node === topology.publicIngress.nodes[0]);
    if (!target) throw new Error('Direct public ingress node was not provisioned');
    return { mode: 'direct' as const, origins: [{ address: target.publicIp }] };
  }
  return {
    mode: topology.publicIngress.mode,
    origins: loadBalancers.publicIngress.map((loadBalancer) => ({
      address: loadBalancer.floatingIp.apply((floatingIp) => floatingIp.ip)
    }))
  };
})();

export const outputs = {
  CloudProjectId: cloudProject.projectId,
  ...(publicIngress && { IngressOrigins: publicIngress.origins.map(({ address }) => address) })
};
