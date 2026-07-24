import { cloudflareZoneId } from '../dns';
import { deleteTailscaleDevices } from '../tailscale';
import { STAGE_NAME, domain, isProduction } from '../utils';
import { NON_PRODUCTION_CLUSTER_CONFIG, OVH_ACCOUNT, PRODUCTION_CLUSTER_CONFIG } from './config';
import { createClusterLoadBalancers, createIpLoadBalancingIngress } from './load-balancers';
import { createClusterNetwork, type ClusterFoundation, type ClusterNetwork } from './network';
import { createDedicatedNodes } from './providers/dedicated';
import { createPublicCloudNodes } from './providers/public-cloud';
import { buildClusterTopology, clusterResourceName, getGlobalPublicIngressMode } from './topology';

const clusterConfig = isProduction ? PRODUCTION_CLUSTER_CONFIG : NON_PRODUCTION_CLUSTER_CONFIG;
const topology = buildClusterTopology(clusterConfig, STAGE_NAME, domain);
for (const { warnings } of topology.clusters) {
  for (const warning of warnings) console.warn(warning);
}

const cloudProject = new ovh.cloudproject.Project(
  'OvhPublicCloudProject',
  {
    deletionProtection: isProduction,
    description: `${STAGE_NAME.capitalize()} Public Cloud project`,
    ovhSubsidiary: OVH_ACCOUNT.subsidiary,
    plan: { duration: 'P1M', planCode: 'project', pricingMode: 'default' }
  },
  { protect: isProduction }
);

function createFoundation(project: ovh.cloudproject.Project): ClusterFoundation {
  const vrack = new ovh.vrack.Vrack(
    'OvhK3sVrack',
    {
      ovhSubsidiary: OVH_ACCOUNT.subsidiary,
      name: `k3s-${STAGE_NAME}`,
      description: `k3s ${STAGE_NAME} private networks`,
      plan: { duration: 'P1M', planCode: 'vrack', pricingMode: 'default' }
    },
    { protect: isProduction }
  );
  const attachment = new ovh.vrack.CloudProject('OvhK3sVrackCloudProject', {
    serviceName: vrack.serviceName,
    projectId: project.projectId
  });
  return {
    projectId: project.projectId,
    subsidiary: OVH_ACCOUNT.subsidiary,
    vrack,
    attachment
  };
}

const foundation = topology.clusters.length > 0 ? createFoundation(cloudProject) : undefined;

const ingressOrigins: Array<{ address: $util.Output<string> }> = [];
const networks = new Map<string, ClusterNetwork>();
for (const cluster of topology.clusters) {
  if (!foundation) throw new Error('Missing OVH account foundation');
  const network = createClusterNetwork(foundation, cluster);
  networks.set(cluster.config.name, network);
  if (cluster.nodes.length === 0) continue;

  const loadBalancers = createClusterLoadBalancers({ network, cluster });
  const privateApiDnsRecord = new cloudflare.DnsRecord(
    clusterResourceName('OvhK3sPrivateApiDnsRecord', cluster.config.name),
    {
      name: cluster.identity.apiHostname,
      zoneId: cloudflareZoneId,
      type: 'A',
      content: loadBalancers.apiTarget,
      proxied: false,
      ttl: 60,
      comment: `private ovh k3s api ${cluster.config.name}`
    }
  );
  const apiAddress = privateApiDnsRecord.id.apply(() => cluster.identity.apiHostname);
  const provisionedNodes: Array<{
    node: (typeof cluster.nodes)[number];
    publicIp: $util.Output<string>;
  }> = [];

  for (const pool of cluster.nodePools) {
    const nodes = cluster.nodes.filter((node) => node.pool === pool);
    if (nodes.length === 0) continue;
    const args = { cluster, nodes, network, apiAddress, protect: isProduction };
    provisionedNodes.push(
      ...(pool.provider === 'public-cloud'
        ? createPublicCloudNodes({ ...args, pool })
        : createDedicatedNodes({ ...args, pool }))
    );
  }

  if (cluster.publicIngress.mode === 'direct') {
    const target = provisionedNodes.find(({ node }) => node === cluster.publicIngress.nodes[0]);
    if (!target) {
      throw new Error(`Direct ingress node was not provisioned in ${cluster.config.name}`);
    }
    ingressOrigins.push({ address: target.publicIp });
  } else if (cluster.publicIngress.mode !== 'ip-load-balancing') {
    ingressOrigins.push(
      ...loadBalancers.publicIngress.map((loadBalancer) => ({
        address: loadBalancer.floatingIp.apply((floatingIp) => floatingIp.ip)
      }))
    );
  }
}

for (const plan of topology.ipLoadBalancing) {
  ingressOrigins.push({ address: createIpLoadBalancingIngress({ plan, networks }) });
}

if (topology.clusters.every(({ nodes }) => nodes.length === 0)) {
  const devices = await tailscale.getDevices({ namePrefix: STAGE_NAME });
  const stale = devices.devices.filter(
    (device) =>
      device.tags.includes('tag:ovh') &&
      device.tags.includes(`tag:${STAGE_NAME}`) &&
      (device.tags.includes('tag:control-plane') || device.tags.includes('tag:worker'))
  );
  if (stale.length) deleteTailscaleDevices(...stale.map((device) => device.nodeId));
}

const ingressMode = getGlobalPublicIngressMode(ingressOrigins.length);
export const publicIngress =
  ingressMode === 'none' ? undefined : { mode: ingressMode, origins: ingressOrigins };

export const outputs = {
  CloudProjectId: cloudProject.projectId,
  EnabledClusters: topology.clusters.map(({ config }) => config.name),
  ...(publicIngress && { IngressOrigins: publicIngress.origins.map(({ address }) => address) })
};
