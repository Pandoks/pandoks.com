import type {
  ClusterConfig,
  ClusterRegionId,
  DedicatedPlanOption,
  IpLoadBalancingServiceConfig,
  LoadBalancerFlavor,
  NodePoolName,
  NodeRole,
  OvhAccountId,
  PublicIngressConfig,
  RegionalClusterConfig,
  Workload
} from './config.ts';

// Every regional /16 keeps the same stable role-owned third-octet layout:
// .0 OVH/Neutron, .1 cloud control planes, .2 cloud workers,
// .3 dedicated control planes, .4 dedicated workers, .5 MetalLB,
// .6 cloud databases, .7 dedicated databases, .8 IP Load Balancing NAT, .9-.255 reserved.
const NODE_POOL_IDENTITIES = {
  'cloud-control-plane': {
    addressBlock: 1,
    logicalNamePrefix: 'ControlPlaneServer',
    hostnamePrefix: 'control-plane-server'
  },
  'cloud-workers': {
    addressBlock: 2,
    logicalNamePrefix: 'WorkerServer',
    hostnamePrefix: 'worker-server'
  },
  'dedicated-control-plane': {
    addressBlock: 3,
    logicalNamePrefix: 'DedicatedControlPlaneServer',
    hostnamePrefix: 'dedicated-control-plane-server'
  },
  'dedicated-workers': {
    addressBlock: 4,
    logicalNamePrefix: 'DedicatedWorkerServer',
    hostnamePrefix: 'dedicated-worker-server'
  },
  'cloud-database': {
    addressBlock: 6,
    logicalNamePrefix: 'DatabaseServer',
    hostnamePrefix: 'database-server'
  },
  'dedicated-database': {
    addressBlock: 7,
    logicalNamePrefix: 'DedicatedDatabaseServer',
    hostnamePrefix: 'dedicated-database-server'
  }
} as const;

type NodePoolBase = {
  name: NodePoolName;
  role: NodeRole;
  workload: Workload;
  count: number;
  publicIngress: boolean;
  machineType: string;
};

export type PublicCloudNodePool = NodePoolBase & {
  provider: 'public-cloud';
  image: string;
  region: string;
};

export type DedicatedNodePool = NodePoolBase & {
  provider: 'dedicated';
  operatingSystem: string;
  datacenter: string;
  orderRegion: string;
  planOptions: DedicatedPlanOption[];
};

export type NodePool = PublicCloudNodePool | DedicatedNodePool;

export type ClusterNodeSpec = {
  pool: NodePool;
  poolIndex: number;
  logicalName: string;
  hostname: string;
  privateIp: string;
  bootstrapCandidate: boolean;
  directIngress: boolean;
};

export type PublicIngressPlan = {
  mode: 'none' | 'direct' | 'ovh' | 'cloudflare' | 'ip-load-balancing';
  nodes: readonly ClusterNodeSpec[];
  loadBalancerCount: number;
  flavor?: LoadBalancerFlavor;
};

export type PrivateApiPlan = {
  mode: 'none' | 'direct' | 'ovh';
  nodes: readonly ClusterNodeSpec[];
};

export type RegionalClusterIdentity = {
  resourcePrefix: string;
  namePrefix: string;
  apiHostname: string;
  operatorHostname: string;
  tokenSecretName: string;
  etcdBackupFolder: string;
};

export type RegionalClusterPlan = {
  config: RegionalClusterConfig;
  identity: RegionalClusterIdentity;
  nodePools: readonly NodePool[];
  nodes: ClusterNodeSpec[];
  warnings: string[];
  privateApi: PrivateApiPlan;
  publicIngress: PublicIngressPlan;
};

export type IpLoadBalancingPlan = {
  config: IpLoadBalancingServiceConfig;
  regions: readonly {
    cluster: RegionalClusterPlan;
    zone: string;
    natIp: string;
  }[];
};

const REGION_RESOURCE_PREFIX: Record<ClusterRegionId, string> = {
  'us-west': '',
  'us-east': 'UsEast',
  eu: 'Eu',
  asia: 'Asia'
};

export function regionalResourceName(name: string, regionId: ClusterRegionId): string {
  const prefix = REGION_RESOURCE_PREFIX[regionId];
  return prefix ? name.replace(/^Ovh/, `Ovh${prefix}`) : name;
}

function identity(config: RegionalClusterConfig, stage: string, domain: string) {
  const isWest = config.id === 'us-west';
  const namePrefix = isWest ? stage : `${stage}-${config.id}`;
  return {
    resourcePrefix: REGION_RESOURCE_PREFIX[config.id],
    namePrefix,
    apiHostname: isWest ? `k3s-api.${domain}` : `k3s-api.${config.id}.${domain}`,
    operatorHostname: `${namePrefix}-cluster`,
    tokenSecretName: isWest ? 'OvhK3sToken' : `Ovh${REGION_RESOURCE_PREFIX[config.id]}K3sToken`,
    etcdBackupFolder: isWest ? 'kubernetes/etcd' : `kubernetes/etcd/${config.id}`
  } satisfies RegionalClusterIdentity;
}

function networkOctet(config: RegionalClusterConfig): number {
  const match = /^10\.(\d{1,3})\.0\.0\/16$/.exec(config.networkCidr);
  const value = Number(match?.[1]);
  if (!match || value > 255) {
    throw new Error(`Cluster region ${config.id} networkCidr must be a 10.x.0.0/16`);
  }
  if (config.gatewayIp !== `10.${value}.0.1`) {
    throw new Error(`Cluster region ${config.id} gatewayIp must be 10.${value}.0.1`);
  }
  if (
    config.allocationPool.start !== `10.${value}.0.2` ||
    config.allocationPool.end !== `10.${value}.0.254`
  ) {
    throw new Error(`Cluster region ${config.id} allocationPool must own .0.2-.0.254`);
  }
  if (config.metalLbRange !== `10.${value}.5.1-10.${value}.5.254`) {
    throw new Error(`Cluster region ${config.id} metalLbRange must own .5.1-.5.254`);
  }
  return value;
}

function validateRegion(config: RegionalClusterConfig): void {
  if (!Number.isInteger(config.vlanId) || config.vlanId < 0 || config.vlanId > 4096) {
    throw new Error(`Cluster region ${config.id} vlanId must be an integer from 0 to 4096`);
  }
  networkOctet(config);
  for (const [name, cidr] of [
    ['podCidr', config.podCidr],
    ['serviceCidr', config.serviceCidr]
  ] as const) {
    if (!/^10\.(?:\d{1,3})\.0\.0\/16$/.test(cidr)) {
      throw new Error(`Cluster region ${config.id} ${name} must be a 10.x.0.0/16`);
    }
  }

  const counts = [...config.cloud, ...config.dedicated].map(({ count }) => count);
  if (!config.enabled && [...counts, config.loadBalancerCount].some((count) => count !== 0)) {
    throw new Error(
      `Disabled cluster region ${config.id} requires every node and load balancer count to be 0`
    );
  }
  if (config.enabled && !config.publicCloudRegion.trim()) {
    throw new Error(`Enabled cluster region ${config.id} requires publicCloudRegion`);
  }
  if (!Number.isInteger(config.loadBalancerCount) || config.loadBalancerCount < 0) {
    throw new Error(`Cluster region ${config.id} loadBalancerCount must be a non-negative integer`);
  }
}

function nodePools(config: RegionalClusterConfig): NodePool[] {
  const pools: NodePool[] = [
    ...config.cloud.map((pool) => ({
      ...pool,
      provider: 'public-cloud' as const,
      image: config.cloudImage,
      region: config.publicCloudRegion
    })),
    ...config.dedicated.map((pool) => ({
      ...pool,
      provider: 'dedicated' as const,
      operatingSystem: config.dedicatedOperatingSystem,
      datacenter: config.dedicatedDatacenter,
      orderRegion: config.dedicatedCatalogRegion
    }))
  ];
  const byName = new Map<NodePoolName, NodePool>();
  for (const pool of pools) {
    if (byName.has(pool.name)) throw new Error(`Duplicate node pool name: ${pool.name}`);
    byName.set(pool.name, pool);
  }
  return (Object.keys(NODE_POOL_IDENTITIES) as NodePoolName[]).flatMap((name) => {
    const pool = byName.get(name);
    return pool ? [pool] : [];
  });
}

function validatePool(pool: NodePool, config: RegionalClusterConfig): void {
  if (!Number.isInteger(pool.count) || pool.count < 0) {
    throw new Error(`Node pool ${pool.name} count must be a non-negative integer`);
  }
  if (pool.count > 254) throw new Error(`Node pool ${pool.name} count cannot exceed 254`);
  if (pool.workload === 'database' && pool.publicIngress) {
    throw new Error(`Node pool ${pool.name} database workload requires publicIngress to be false`);
  }
  if (pool.workload === 'database' && pool.role !== 'worker') {
    throw new Error(`Node pool ${pool.name} database workload requires the worker role`);
  }
  if (pool.count > 0 && !pool.machineType.trim()) {
    throw new Error(`Enabled node pool ${pool.name} requires machineType`);
  }
  if (pool.provider === 'dedicated' && pool.count > 0) {
    if (!config.dedicatedDatacenter.trim()) {
      throw new Error(`Enabled dedicated pool ${pool.name} requires dedicatedDatacenter`);
    }
    if (!config.dedicatedCatalogRegion.trim()) {
      throw new Error(`Enabled dedicated pool ${pool.name} requires dedicatedCatalogRegion`);
    }
    if (!pool.operatingSystem.trim()) {
      throw new Error(`Enabled dedicated pool ${pool.name} requires operatingSystem`);
    }
  }
}

export function buildRegionalClusterPlan(
  config: RegionalClusterConfig,
  stage: string,
  domain: string,
  publicIngressConfig: PublicIngressConfig = { type: 'public-cloud', flavor: 'small' }
): RegionalClusterPlan {
  validateRegion(config);
  const clusterIdentity = identity(config, stage, domain);
  const normalizedPools = nodePools(config);
  const nodes: ClusterNodeSpec[] = [];
  const secondOctet = networkOctet(config);

  for (const pool of normalizedPools) {
    validatePool(pool, config);
    const poolIdentity = NODE_POOL_IDENTITIES[pool.name];
    for (let poolIndex = 0; poolIndex < pool.count; poolIndex += 1) {
      nodes.push({
        pool,
        poolIndex,
        logicalName: `Ovh${clusterIdentity.resourcePrefix}${poolIdentity.logicalNamePrefix}${poolIndex}`,
        hostname: `${clusterIdentity.namePrefix}-ovh-${poolIdentity.hostnamePrefix}-${poolIndex}`,
        privateIp: `10.${secondOctet}.${poolIdentity.addressBlock}.${poolIndex + 1}`,
        bootstrapCandidate: false,
        directIngress: false
      });
    }
  }

  const controlPlanes = nodes.filter(({ pool }) => pool.role === 'control-plane');
  if (nodes.length > 0 && controlPlanes.length === 0) {
    throw new Error(`Cluster region ${config.id} nodes require at least one control-plane node`);
  }
  if (controlPlanes[0]) controlPlanes[0].bootstrapCandidate = true;

  const privateApi: PrivateApiPlan = {
    mode: controlPlanes.length === 0 ? 'none' : controlPlanes.length === 1 ? 'direct' : 'ovh',
    nodes: controlPlanes
  };
  const ingressNodes = nodes.filter(({ pool }) => pool.publicIngress);
  if (publicIngressConfig.type === 'ip-load-balancing') {
    if (config.loadBalancerCount !== 0) {
      throw new Error('IP Load Balancing requires loadBalancerCount to be 0');
    }
  } else {
    if (ingressNodes.length < 2 && config.loadBalancerCount !== 0) {
      throw new Error(
        `${ingressNodes.length === 0 ? 'no' : 'one'} ingress node requires loadBalancerCount to be 0`
      );
    }
    if (ingressNodes.length > 1 && config.loadBalancerCount === 0) {
      throw new Error('multiple ingress nodes require at least one load balancer');
    }
    if (ingressNodes.length === 1) ingressNodes[0].directIngress = true;
  }

  const publicIngress: PublicIngressPlan = {
    mode:
      ingressNodes.length === 0
        ? 'none'
        : publicIngressConfig.type === 'ip-load-balancing'
          ? 'ip-load-balancing'
          : ingressNodes.length === 1
            ? 'direct'
            : config.loadBalancerCount === 1
              ? 'ovh'
              : 'cloudflare',
    nodes: ingressNodes,
    loadBalancerCount: config.loadBalancerCount,
    ...(publicIngressConfig.type === 'public-cloud' && { flavor: publicIngressConfig.flavor })
  };
  const warnings: string[] = [];
  if (controlPlanes.length > 0 && (controlPlanes.length < 3 || controlPlanes.length % 2 === 0)) {
    warnings.push(
      `Embedded-etcd HA recommends an odd control-plane count of at least 3; configured ${controlPlanes.length}`
    );
  }
  return {
    config,
    identity: clusterIdentity,
    nodePools: normalizedPools,
    nodes,
    warnings,
    privateApi,
    publicIngress
  };
}

function unique(
  plans: readonly RegionalClusterPlan[],
  field: 'networkCidr' | 'podCidr' | 'serviceCidr'
) {
  const seen = new Set<string>();
  for (const plan of plans) {
    const value = plan.config[field];
    if (seen.has(value)) {
      const label =
        field === 'networkCidr'
          ? 'network CIDR'
          : field === 'podCidr'
            ? 'pod CIDR'
            : 'service CIDR';
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

export function buildClusterTopology(config: ClusterConfig, stage: string, domain: string) {
  const ids = new Set<ClusterRegionId>();
  const plans = config.regions.map((region) => {
    if (ids.has(region.id)) throw new Error(`Duplicate cluster region: ${region.id}`);
    ids.add(region.id);
    return buildRegionalClusterPlan(region, stage, domain, config.publicIngress);
  });
  const enabled = plans.filter(({ config: region }) => region.enabled);
  for (const plan of enabled) {
    const duplicateVlan = enabled.find(
      (other) =>
        other !== plan &&
        other.config.account === plan.config.account &&
        other.config.vlanId === plan.config.vlanId
    );
    if (duplicateVlan) {
      throw new Error(
        `Duplicate VLAN ${plan.config.vlanId} for OVH account ${plan.config.account}`
      );
    }
  }
  unique(enabled, 'networkCidr');
  unique(enabled, 'podCidr');
  unique(enabled, 'serviceCidr');

  const ipLoadBalancing: IpLoadBalancingPlan[] = [];
  if (config.publicIngress.type === 'ip-load-balancing') {
    const services = new Map<OvhAccountId, IpLoadBalancingServiceConfig>();
    for (const service of config.publicIngress.services) {
      if (services.has(service.account)) {
        throw new Error(`Duplicate IP Load Balancing service for OVH account ${service.account}`);
      }
      if (!service.serviceName.trim()) {
        throw new Error(
          `IP Load Balancing service for OVH account ${service.account} requires serviceName`
        );
      }
      services.set(service.account, service);
    }
    for (const plan of enabled) {
      if (plan.publicIngress.nodes.length === 0) continue;
      const service = services.get(plan.config.account);
      if (!service) {
        throw new Error(
          `Cluster region ${plan.config.id} requires an IP Load Balancing service for OVH account ${plan.config.account}`
        );
      }
      if (!service.zones[plan.config.id]?.trim()) {
        throw new Error(
          `IP Load Balancing service ${service.serviceName} requires an IP Load Balancing zone for region ${plan.config.id}`
        );
      }
    }
    for (const service of services.values()) {
      const regions = enabled
        .filter(
          (plan) => plan.config.account === service.account && plan.publicIngress.nodes.length > 0
        )
        .map((cluster) => ({
          cluster,
          zone: service.zones[cluster.config.id]!,
          natIp: `10.${networkOctet(cluster.config)}.8.0/24`
        }));
      if (regions.length > 0) ipLoadBalancing.push({ config: service, regions });
    }
  }
  return { regions: enabled, ipLoadBalancing };
}

export function getGlobalPublicIngressMode(originCount: number) {
  return originCount === 0 ? 'none' : originCount === 1 ? 'direct' : 'cloudflare';
}

// Retained for the documented future highest-index-first scale-down workflow.
export function getPoolScaleDownTarget(
  pool: NodePool,
  config: RegionalClusterConfig,
  stage: string
) {
  if (pool.count < 1) throw new Error(`Node pool ${pool.name} has no node to remove`);
  const poolIdentity = NODE_POOL_IDENTITIES[pool.name];
  const clusterIdentity = identity(config, stage, 'unused.invalid');
  const index = pool.count - 1;
  return {
    index,
    logicalName: `Ovh${clusterIdentity.resourcePrefix}${poolIdentity.logicalNamePrefix}${index}`,
    hostname: `${clusterIdentity.namePrefix}-ovh-${poolIdentity.hostnamePrefix}-${index}`
  };
}
