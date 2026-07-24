import { cloudflareZoneId } from '../dns';
import { deleteTailscaleDevices } from '../tailscale';
import { STAGE_NAME, domain, isProduction } from '../utils';
import {
  NON_PRODUCTION_CLUSTER_CONFIG,
  OVH_ACCOUNTS,
  PRODUCTION_CLUSTER_CONFIG,
  type ClusterRegionKey,
  type OvhAccountKey
} from './config';
import { createClusterLoadBalancers, createIpLoadBalancingIngress } from './load-balancers';
import { createClusterNetwork, type ClusterFoundation, type ClusterNetwork } from './network';
import { createDedicatedNodes } from './providers/dedicated';
import { createPublicCloudNodes } from './providers/public-cloud';
import { buildClusterTopology, getGlobalPublicIngressMode, regionalResourceName } from './topology';

const clusterConfig = isProduction ? PRODUCTION_CLUSTER_CONFIG : NON_PRODUCTION_CLUSTER_CONFIG;
const topology = buildClusterTopology(clusterConfig, STAGE_NAME, domain);
for (const { warnings } of topology.regions) {
  for (const warning of warnings) console.warn(warning);
}

const cloudProject = new ovh.cloudproject.Project(
  'OvhPublicCloudProject',
  {
    deletionProtection: isProduction,
    description: `${STAGE_NAME.capitalize()} Public Cloud project`,
    ovhSubsidiary: OVH_ACCOUNTS.us.subsidiary,
    plan: { duration: 'P1M', planCode: 'project', pricingMode: 'default' }
  },
  { protect: isProduction }
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Enabled OVH account requires ${name}`);
  return value;
}

const enabledAccounts = new Set(topology.regions.map(({ config }) => config.account));
let euProvider: ovh.Provider | undefined;
let euProject: ovh.cloudproject.Project | undefined;
if (enabledAccounts.has('eu')) {
  const account = OVH_ACCOUNTS.eu;
  if (!account.subsidiary) {
    throw new Error('Enabled OVH EU regions require a verified OVH subsidiary in config.ts');
  }
  euProvider = new ovh.Provider('OvhEuProvider', {
    endpoint: account.endpoint,
    applicationKey: requiredEnvironment(account.applicationKeyEnvironment),
    applicationSecret: requiredEnvironment(account.applicationSecretEnvironment),
    consumerKey: requiredEnvironment(account.consumerKeyEnvironment)
  });
  euProject = new ovh.cloudproject.Project(
    'OvhEuPublicCloudProject',
    {
      deletionProtection: isProduction,
      description: `${STAGE_NAME.capitalize()} EU Public Cloud project`,
      ovhSubsidiary: account.subsidiary,
      plan: { duration: 'P1M', planCode: 'project', pricingMode: 'default' }
    },
    { protect: isProduction, provider: euProvider }
  );
}

function createFoundation(
  accountId: OvhAccountKey,
  project: ovh.cloudproject.Project,
  provider?: ovh.Provider
): ClusterFoundation {
  const account = OVH_ACCOUNTS[accountId];
  const regionId = accountId === 'us' ? 'us-west' : 'eu';
  const options = { protect: isProduction, ...(provider && { provider }) };
  const vrack = new ovh.vrack.Vrack(
    regionalResourceName('OvhK3sVrack', regionId),
    {
      ovhSubsidiary: account.subsidiary,
      name: `k3s-${accountId === 'us' ? '' : `${accountId}-`}${STAGE_NAME}`,
      description: `k3s ${STAGE_NAME} ${accountId} private networks`,
      plan: { duration: 'P1M', planCode: 'vrack', pricingMode: 'default' }
    },
    options
  );
  const attachment = new ovh.vrack.CloudProject(
    regionalResourceName('OvhK3sVrackCloudProject', regionId),
    { serviceName: vrack.serviceName, projectId: project.projectId },
    provider ? { provider } : {}
  );
  return {
    projectId: project.projectId,
    subsidiary: account.subsidiary,
    vrack,
    attachment,
    ...(provider && { provider })
  };
}

const foundations: Partial<Record<OvhAccountKey, ClusterFoundation>> = {};
if (enabledAccounts.has('us')) foundations.us = createFoundation('us', cloudProject);
if (enabledAccounts.has('eu') && euProject && euProvider) {
  foundations.eu = createFoundation('eu', euProject, euProvider);
}

const ingressOrigins: Array<{ address: $util.Output<string> }> = [];
const networks = new Map<ClusterRegionKey, ClusterNetwork>();
for (const cluster of topology.regions) {
  const foundation = foundations[cluster.config.account];
  if (!foundation) throw new Error(`Missing OVH ${cluster.config.account} account foundation`);
  const network = createClusterNetwork(foundation, cluster);
  networks.set(cluster.config.id, network);
  if (cluster.nodes.length === 0) continue;

  const loadBalancers = createClusterLoadBalancers({ network, cluster });
  const privateApiDnsRecord = new cloudflare.DnsRecord(
    regionalResourceName('OvhK3sPrivateApiDnsRecord', cluster.config.id),
    {
      name: cluster.identity.apiHostname,
      zoneId: cloudflareZoneId,
      type: 'A',
      content: loadBalancers.apiTarget,
      proxied: false,
      ttl: 60,
      comment: `private ovh k3s api ${cluster.config.id}`
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
    if (!target) throw new Error(`Direct ingress node was not provisioned in ${cluster.config.id}`);
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

if (topology.regions.every(({ nodes }) => nodes.length === 0)) {
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
  EnabledClusterRegions: topology.regions.map(({ config }) => config.id),
  ...(euProject && { EuCloudProjectId: euProject.projectId }),
  ...(publicIngress && { IngressOrigins: publicIngress.origins.map(({ address }) => address) })
};
