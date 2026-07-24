import type {
  ClusterConfig,
  ClusterRegion,
  ClusterSpec,
  DedicatedPlanOption,
  DerivedNetwork,
  InterconnectConfig,
  IpLoadBalancingServiceConfig,
  NodeRole,
  NodeTaint,
  PublicCloudRegion,
  PublicIngressConfig
} from './config.ts';

// Every cluster /16 keeps the same derived third-octet layout:
// .0 OVH/Neutron, .1-.199 node pools in declaration order, .200 MetalLB,
// .254 IP Load Balancing NAT, the rest reserved.
const METAL_LB_OCTET = 200;
const NAT_OCTET = 254;
const MAX_NETWORK_INDEX = 15;
const MAX_POOL_COUNT = 254;
const NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;

// Every OVH datacenter permanently owns a network index; the whole address plan
// derives from it, so entries must never be renumbered.
export const CLUSTER_NETWORK_INDEXES: Record<ClusterRegion, number> = {
  vin: 0,
  hil: 1,
  bhs: 2,
  tor: 3,
  gra: 4,
  rbx: 5,
  sbg: 6,
  par: 7,
  fra: 8,
  lon: 9,
  waw: 10,
  mil: 11,
  sgp: 12,
  syd: 13,
  ynm: 14
};

const PUBLIC_CLOUD_REGIONS: Partial<Record<ClusterRegion, PublicCloudRegion>> = {
  hil: 'US-WEST-OR-1',
  vin: 'US-EAST-VA-1'
};

const DEDICATED_ORDER_REGIONS: Record<ClusterRegion, 'usa' | 'canada' | 'europe' | 'apac'> = {
  vin: 'usa',
  hil: 'usa',
  bhs: 'canada',
  tor: 'canada',
  gra: 'europe',
  rbx: 'europe',
  sbg: 'europe',
  par: 'europe',
  fra: 'europe',
  lon: 'europe',
  waw: 'europe',
  mil: 'europe',
  sgp: 'apac',
  syd: 'apac',
  ynm: 'apac'
};

type NodePoolBase = {
  name: string;
  role: NodeRole;
  count: number;
  labels: Record<string, string>;
  taints: NodeTaint[];
  publicIngress: boolean;
  interconnect: boolean;
  addressBlock: number;
};

export type PublicCloudNodePool = NodePoolBase & {
  provider: 'public-cloud';
  region: PublicCloudRegion;
  flavor: string;
  image: string;
};

export type DedicatedNodePool = NodePoolBase & {
  provider: 'dedicated';
  datacenter: string;
  planCode: string;
  operatingSystem: string;
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
  interconnectIp?: string;
  bootstrapCandidate: boolean;
  directIngress: boolean;
};

export type PublicIngressPlan = {
  mode: 'none' | 'direct' | 'ovh' | 'cloudflare' | 'ip-load-balancing';
  nodes: readonly ClusterNodeSpec[];
  loadBalancerCount: number;
  flavor?: string;
};

export type PrivateApiPlan = {
  mode: 'none' | 'direct' | 'ovh';
  nodes: readonly ClusterNodeSpec[];
};

export type ClusterIdentity = {
  resourcePrefix: string;
  namePrefix: string;
  apiHostname: string;
  operatorHostname: string;
  tokenSecretName: string;
  etcdBackupFolder: string;
};

export type InterconnectPlan = InterconnectConfig & {
  prefixLength: number;
};

export type ClusterPlan = {
  config: ClusterSpec;
  identity: ClusterIdentity;
  network: DerivedNetwork;
  interconnect?: InterconnectPlan;
  nodePools: readonly NodePool[];
  nodes: ClusterNodeSpec[];
  warnings: string[];
  privateApi: PrivateApiPlan;
  publicIngress: PublicIngressPlan;
};

export type IpLoadBalancingPlan = {
  config: IpLoadBalancingServiceConfig;
  clusters: readonly {
    cluster: ClusterPlan;
    zone: string;
    natIp: string;
  }[];
};

export function pascalCase(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function clusterResourceName(name: string, region: string): string {
  return name.replace(/^Ovh/, `Ovh${pascalCase(region)}`);
}

export function clusterTokenSecretName(region: string): string {
  return `Ovh${pascalCase(region)}K3sToken`;
}

export function networkIndex(region: ClusterRegion): number {
  const index: number | undefined = CLUSTER_NETWORK_INDEXES[region];
  if (index === undefined) throw new Error(`Unknown cluster region: ${region}`);
  return index;
}

function validateNetworkIndexes(): void {
  const indexes = new Set<number>();
  for (const [region, index] of Object.entries(CLUSTER_NETWORK_INDEXES)) {
    if (!NAME_PATTERN.test(region)) {
      throw new Error(`Cluster region ${region} must be lowercase kebab-case`);
    }
    if (!Number.isInteger(index) || index < 0 || index > MAX_NETWORK_INDEX) {
      throw new Error(
        `Cluster region ${region} network index must be an integer from 0 to ${MAX_NETWORK_INDEX}`
      );
    }
    if (indexes.has(index)) throw new Error(`Duplicate cluster network index: ${index}`);
    indexes.add(index);
  }
}

function identity(spec: ClusterSpec, stage: string, domain: string): ClusterIdentity {
  const namePrefix = `${stage}-${spec.region}`;
  return {
    resourcePrefix: pascalCase(spec.region),
    namePrefix,
    apiHostname: `k3s-api.${spec.region}.${domain}`,
    operatorHostname: `${namePrefix}-cluster`,
    tokenSecretName: clusterTokenSecretName(spec.region),
    etcdBackupFolder: `kubernetes/etcd/${spec.region}`
  };
}

function parseInterconnect(interconnect: InterconnectConfig): InterconnectPlan {
  const match = /^(\d{1,3})\.(\d{1,3})\.0\.0\/12$/.exec(interconnect.cidr);
  if (!match || Number(match[2]) % 16 !== 0 || Number(match[1]) > 255 || Number(match[2]) > 240) {
    throw new Error('Interconnect cidr must be an a.b.0.0/12 network with b a multiple of 16');
  }
  if (
    !Number.isInteger(interconnect.vlanId) ||
    interconnect.vlanId < 1 ||
    interconnect.vlanId > 4096
  ) {
    throw new Error('Interconnect vlanId must be an integer from 1 to 4096');
  }
  return { ...interconnect, prefixLength: 12 };
}

function interconnectAddress(
  interconnect: InterconnectConfig,
  index: number,
  addressBlock: number,
  hostIndex: number
): string {
  const [first = '0', second = '0'] = interconnect.cidr.split('/')[0].split('.');
  return `${first}.${Number(second) + index}.${addressBlock}.${hostIndex}`;
}

function validateKeyValue(kind: string, pool: string, key: string, value: string): void {
  if (!key.trim() || /[\s,]/.test(key) || /[\s,]/.test(value)) {
    throw new Error(`Node pool ${pool} ${kind} keys and values cannot contain spaces or commas`);
  }
}

function deriveNetwork(spec: ClusterSpec): DerivedNetwork {
  const index = networkIndex(spec.region);
  // Dedicated-only regions still need a home for their Neutron network objects;
  // default to the geographically closer US Public Cloud region.
  const publicCloudRegion =
    PUBLIC_CLOUD_REGIONS[spec.region] ??
    (DEDICATED_ORDER_REGIONS[spec.region] === 'apac' ? 'US-WEST-OR-1' : 'US-EAST-VA-1');
  const derived: DerivedNetwork = {
    publicCloudRegion,
    vlanId: index,
    networkCidr: `10.${index}.0.0/16`,
    gatewayIp: `10.${index}.0.1`,
    allocationPool: { start: `10.${index}.0.2`, end: `10.${index}.0.254` },
    podCidr: `10.${42 + 2 * index}.0.0/16`,
    serviceCidr: `10.${43 + 2 * index}.0.0/16`,
    metalLbRange: `10.${index}.${METAL_LB_OCTET}.1-10.${index}.${METAL_LB_OCTET}.254`
  };
  const network = { ...derived, ...spec.network };
  if (!Number.isInteger(network.vlanId) || network.vlanId < 0 || network.vlanId > 4096) {
    throw new Error(`Cluster ${spec.region} vlanId must be an integer from 0 to 4096`);
  }
  for (const [field, cidr] of [
    ['networkCidr', network.networkCidr],
    ['podCidr', network.podCidr],
    ['serviceCidr', network.serviceCidr]
  ] as const) {
    if (!/^10\.\d{1,3}\.0\.0\/16$/.test(cidr)) {
      throw new Error(`Cluster ${spec.region} ${field} must be a 10.x.0.0/16`);
    }
  }
  return network;
}

function nodePools(spec: ClusterSpec): NodePool[] {
  if (spec.pools.length >= METAL_LB_OCTET) {
    throw new Error(`Cluster ${spec.region} cannot declare more than ${METAL_LB_OCTET - 1} pools`);
  }
  const names = new Set<string>();
  return spec.pools.map((pool, position) => {
    if (!NAME_PATTERN.test(pool.name)) {
      throw new Error(`Node pool name ${pool.name} must be lowercase kebab-case`);
    }
    if (names.has(pool.name)) throw new Error(`Duplicate node pool name: ${pool.name}`);
    names.add(pool.name);
    if (!Number.isInteger(pool.count) || pool.count < 0) {
      throw new Error(`Node pool ${pool.name} count must be a non-negative integer`);
    }
    if (pool.count > MAX_POOL_COUNT) {
      throw new Error(`Node pool ${pool.name} count cannot exceed ${MAX_POOL_COUNT}`);
    }
    for (const [key, value] of Object.entries(pool.labels ?? {})) {
      validateKeyValue('label', pool.name, key, value);
    }
    for (const taint of pool.taints ?? []) {
      validateKeyValue('taint', pool.name, taint.key, taint.value);
    }
    const base: NodePoolBase = {
      name: pool.name,
      role: pool.role,
      count: pool.count,
      labels: pool.labels ?? {},
      taints: pool.taints ?? [],
      publicIngress: pool.publicIngress ?? false,
      interconnect: pool.interconnect ?? false,
      addressBlock: position + 1
    };
    if (pool.server.type === 'public-cloud') {
      if (base.interconnect) {
        throw new Error(
          `Node pool ${pool.name} cannot join the interconnect: Public Cloud instances support a single private NIC`
        );
      }
      const region = PUBLIC_CLOUD_REGIONS[spec.region];
      if (!region) {
        throw new Error(
          `Cluster ${spec.region} cannot host public cloud pools: no Public Cloud region in that datacenter`
        );
      }
      if (pool.count > 0 && (!pool.server.flavor.trim() || !pool.server.image.trim())) {
        throw new Error(`Enabled node pool ${pool.name} requires flavor and image`);
      }
      return {
        ...base,
        provider: 'public-cloud',
        region,
        flavor: pool.server.flavor,
        image: pool.server.image
      };
    }
    if (pool.count > 0 && (!pool.server.planCode.trim() || !pool.server.operatingSystem.trim())) {
      throw new Error(`Enabled dedicated pool ${pool.name} requires planCode and operatingSystem`);
    }
    return {
      ...base,
      provider: 'dedicated',
      datacenter: spec.region,
      planCode: pool.server.planCode,
      operatingSystem: pool.server.operatingSystem,
      orderRegion: DEDICATED_ORDER_REGIONS[spec.region],
      planOptions: pool.server.planOptions
    };
  });
}

export function buildClusterPlan(
  spec: ClusterSpec,
  stage: string,
  domain: string,
  publicIngressConfig: PublicIngressConfig = { type: 'public-cloud', flavor: 'small' },
  interconnectConfig: InterconnectConfig = { vlanId: 4000, cidr: '172.16.0.0/12' }
): ClusterPlan {
  validateNetworkIndexes();
  const index = networkIndex(spec.region);
  const network = deriveNetwork(spec);
  const interconnect = parseInterconnect(interconnectConfig);
  if (interconnect.vlanId === network.vlanId) {
    throw new Error(`Cluster ${spec.region} vlanId collides with the interconnect VLAN`);
  }
  const loadBalancerCount = spec.loadBalancerCount ?? 0;
  if (!Number.isInteger(loadBalancerCount) || loadBalancerCount < 0) {
    throw new Error(`Cluster ${spec.region} loadBalancerCount must be a non-negative integer`);
  }
  const clusterIdentity = identity(spec, stage, domain);
  const pools = nodePools(spec);
  const octet = Number(/^10\.(\d{1,3})\./.exec(network.networkCidr)![1]);
  const nodes: ClusterNodeSpec[] = [];
  const usesInterconnect = pools.some((pool) => pool.interconnect && pool.count > 0);

  for (const pool of pools) {
    for (let poolIndex = 0; poolIndex < pool.count; poolIndex += 1) {
      nodes.push({
        pool,
        poolIndex,
        logicalName: `Ovh${clusterIdentity.resourcePrefix}${pascalCase(pool.name)}Server${poolIndex}`,
        hostname: `${clusterIdentity.namePrefix}-ovh-${pool.name}-server-${poolIndex}`,
        privateIp: `10.${octet}.${pool.addressBlock}.${poolIndex + 1}`,
        ...(pool.interconnect && {
          interconnectIp: interconnectAddress(interconnect, index, pool.addressBlock, poolIndex + 1)
        }),
        bootstrapCandidate: false,
        directIngress: false
      });
    }
  }

  const controlPlanes = nodes.filter(({ pool }) => pool.role === 'control-plane');
  if (nodes.length > 0 && controlPlanes.length === 0) {
    throw new Error(`Cluster ${spec.region} nodes require at least one control-plane node`);
  }
  if (controlPlanes[0]) controlPlanes[0].bootstrapCandidate = true;

  const privateApi: PrivateApiPlan = {
    mode: controlPlanes.length === 0 ? 'none' : controlPlanes.length === 1 ? 'direct' : 'ovh',
    nodes: controlPlanes
  };
  const ingressNodes = nodes.filter(({ pool }) => pool.publicIngress);
  if (publicIngressConfig.type === 'ip-load-balancing') {
    if (loadBalancerCount !== 0) {
      throw new Error('IP Load Balancing requires loadBalancerCount to be 0');
    }
  } else {
    if (ingressNodes.length < 2 && loadBalancerCount !== 0) {
      throw new Error(
        `${ingressNodes.length === 0 ? 'no' : 'one'} ingress node requires loadBalancerCount to be 0`
      );
    }
    if (ingressNodes.length > 1 && loadBalancerCount === 0) {
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
            : loadBalancerCount === 1
              ? 'ovh'
              : 'cloudflare',
    nodes: ingressNodes,
    loadBalancerCount,
    ...(publicIngressConfig.type === 'public-cloud' && { flavor: publicIngressConfig.flavor })
  };
  const warnings: string[] = [];
  if (controlPlanes.length > 0 && (controlPlanes.length < 3 || controlPlanes.length % 2 === 0)) {
    warnings.push(
      `Embedded-etcd HA recommends an odd control-plane count of at least 3; configured ${controlPlanes.length}`
    );
  }
  return {
    config: spec,
    identity: clusterIdentity,
    network,
    ...(usesInterconnect && { interconnect }),
    nodePools: pools,
    nodes,
    warnings,
    privateApi,
    publicIngress
  };
}

function unique(plans: readonly ClusterPlan[], field: 'networkCidr' | 'podCidr' | 'serviceCidr') {
  const seen = new Set<string>();
  for (const plan of plans) {
    const value = plan.network[field];
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
  const regions = new Set<ClusterRegion>();
  const clusters = config.clusters.map((spec) => {
    if (regions.has(spec.region)) throw new Error(`Duplicate cluster region: ${spec.region}`);
    regions.add(spec.region);
    return buildClusterPlan(spec, stage, domain, config.publicIngress, config.interconnect);
  });
  const vlans = new Set<number>();
  for (const plan of clusters) {
    if (vlans.has(plan.network.vlanId)) {
      throw new Error(`Duplicate VLAN ${plan.network.vlanId}`);
    }
    vlans.add(plan.network.vlanId);
  }
  unique(clusters, 'networkCidr');
  unique(clusters, 'podCidr');
  unique(clusters, 'serviceCidr');

  const ipLoadBalancing: IpLoadBalancingPlan[] = [];
  if (config.publicIngress.type === 'ip-load-balancing') {
    const serviceNames = new Set<string>();
    for (const service of config.publicIngress.services) {
      if (!service.serviceName.trim()) {
        throw new Error('IP Load Balancing services require serviceName');
      }
      if (serviceNames.has(service.serviceName)) {
        throw new Error(`Duplicate IP Load Balancing service: ${service.serviceName}`);
      }
      serviceNames.add(service.serviceName);
      for (const zoneRegion of Object.keys(service.zones)) {
        if (!regions.has(zoneRegion as ClusterRegion)) {
          throw new Error(
            `IP Load Balancing service ${service.serviceName} references unknown cluster ${zoneRegion}`
          );
        }
      }
    }
    for (const plan of clusters) {
      if (plan.publicIngress.nodes.length === 0) continue;
      const matches = config.publicIngress.services.filter((service) =>
        service.zones[plan.config.region]?.trim()
      );
      if (matches.length !== 1) {
        throw new Error(
          `Cluster ${plan.config.region} requires exactly one IP Load Balancing zone across services`
        );
      }
    }
    for (const service of config.publicIngress.services) {
      const serviceClusters = clusters
        .filter(
          (plan) => plan.publicIngress.nodes.length > 0 && service.zones[plan.config.region]?.trim()
        )
        .map((cluster) => ({
          cluster,
          zone: service.zones[cluster.config.region],
          natIp: `10.${networkIndex(cluster.config.region)}.${NAT_OCTET}.0/24`
        }));
      if (serviceClusters.length > 0) {
        ipLoadBalancing.push({ config: service, clusters: serviceClusters });
      }
    }
  }
  return { clusters, ipLoadBalancing };
}

export function getGlobalPublicIngressMode(originCount: number) {
  return originCount === 0 ? 'none' : originCount === 1 ? 'direct' : 'cloudflare';
}

// Retained for the documented future highest-index-first scale-down workflow.
export function getPoolScaleDownTarget(plan: ClusterPlan, poolName: string) {
  const pool = plan.nodePools.find(({ name }) => name === poolName);
  if (!pool) throw new Error(`Unknown node pool: ${poolName}`);
  if (pool.count < 1) throw new Error(`Node pool ${pool.name} has no node to remove`);
  const index = pool.count - 1;
  return {
    index,
    logicalName: `Ovh${plan.identity.resourcePrefix}${pascalCase(pool.name)}Server${index}`,
    hostname: `${plan.identity.namePrefix}-ovh-${pool.name}-server-${index}`
  };
}
