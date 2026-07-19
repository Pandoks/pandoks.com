export type NodeProvider = 'public-cloud' | 'dedicated';
export type NodeRole = 'control-plane' | 'worker';
export type NodePoolName =
  | 'cloud-control-plane'
  | 'cloud-workers'
  | 'dedicated-control-plane'
  | 'dedicated-workers';

type AddressRange = {
  thirdOctet: number;
  start: number;
  end: number;
};

type ReservedAddressRange = {
  startThirdOctet: number;
  endThirdOctet: number;
};

export const CLUSTER_NETWORK_CIDR = '10.0.0.0/16';

// 10.0.0.x              OVH/Neutron infrastructure
// 10.0.1.x              Public Cloud control planes
// 10.0.2.x              Public Cloud workers
// 10.0.3.x              Dedicated control planes
// 10.0.4.x              Dedicated workers
// 10.0.5.x              MetalLB services
// 10.0.6.x-10.0.255.x   Reserved
export const CLUSTER_ADDRESS_PLAN = {
  infrastructure: { thirdOctet: 0, start: 2, end: 254 },
  'cloud-control-plane': { thirdOctet: 1, start: 1, end: 254 },
  'cloud-workers': { thirdOctet: 2, start: 1, end: 254 },
  'dedicated-control-plane': { thirdOctet: 3, start: 1, end: 254 },
  'dedicated-workers': { thirdOctet: 4, start: 1, end: 254 },
  metalLb: { thirdOctet: 5, start: 1, end: 254 },
  reserved: { startThirdOctet: 6, endThirdOctet: 255 }
} as const satisfies Readonly<
  Record<'infrastructure' | 'metalLb' | NodePoolName, AddressRange> & {
    reserved: ReservedAddressRange;
  }
>;

export const CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY = 25;
export const CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP = 1;
// Reserve one infrastructure address for the subnet's DHCP service port and one for
// the gateway/router port. This is intentionally conservative and is included
// even for an empty compute topology because the shared network still exists.
export const CLUSTER_NETWORK_INFRASTRUCTURE_CONSUMERS = 2;

type NodePoolBase = {
  name: NodePoolName;
  provider: NodeProvider;
  role: NodeRole;
  count: number;
  ingress: boolean;
};

export type PublicCloudNodePool = NodePoolBase & {
  provider: 'public-cloud';
  flavor: string;
  image: string;
  region: string;
};

export type DedicatedPlanOption = {
  duration: string;
  planCode: string;
  pricingMode: string;
  quantity: number;
};

export type DedicatedNodePool = NodePoolBase & {
  provider: 'dedicated';
  plan: string;
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
  role: NodeRole;
  provider: NodeProvider;
  ingress: boolean;
  bootstrapCandidate: boolean;
};

export type TopologyResult = {
  nodes: ClusterNodeSpec[];
  warnings: string[];
};

export const NODE_POOL_IDENTITIES = {
  'cloud-control-plane': {
    logicalNamePrefix: 'OvhControlPlaneServer',
    hostnamePrefix: 'control-plane-server'
  },
  'cloud-workers': {
    logicalNamePrefix: 'OvhWorkerServer',
    hostnamePrefix: 'worker-server'
  },
  'dedicated-control-plane': {
    logicalNamePrefix: 'OvhDedicatedControlPlaneServer',
    hostnamePrefix: 'dedicated-control-plane-server'
  },
  'dedicated-workers': {
    logicalNamePrefix: 'OvhDedicatedWorkerServer',
    hostnamePrefix: 'dedicated-worker-server'
  }
} as const satisfies Readonly<
  Record<NodePoolName, { logicalNamePrefix: string; hostnamePrefix: string }>
>;

export function getPoolScaleDownTarget(
  pool: NodePool,
  stage: string
): { index: number; logicalName: string; hostname: string } {
  if (pool.count < 1) {
    throw new Error(`Node pool ${pool.name} has no node to remove`);
  }
  const index = pool.count - 1;
  const identity = NODE_POOL_IDENTITIES[pool.name];
  return {
    index,
    logicalName: `${identity.logicalNamePrefix}${index}`,
    hostname: `${stage}-ovh-${identity.hostnamePrefix}-${index}`
  };
}

function parse16Cidr(cidr: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})\.0\.0\/16$/.exec(cidr);
  if (!match) {
    throw new Error(`Cluster CIDR must be an IPv4 /16 ending in .0.0: ${cidr}`);
  }
  for (const octet of match.slice(1).map(Number)) {
    if (octet < 0 || octet > 255) {
      throw new Error(`Cluster CIDR contains an invalid octet: ${cidr}`);
    }
  }
  return `${match[1]}.${match[2]}`;
}

export function formatClusterIp(cidr: string, thirdOctet: number, hostOctet: number): string {
  const networkPrefix = parse16Cidr(cidr);
  if (!Number.isInteger(thirdOctet) || thirdOctet < 0 || thirdOctet > 255) {
    throw new Error(`Cluster IP has an invalid third octet: ${thirdOctet}`);
  }
  if (!Number.isInteger(hostOctet) || hostOctet < 1 || hostOctet > 254) {
    throw new Error(`Cluster IP has an invalid host octet: ${hostOctet}`);
  }
  return `${networkPrefix}.${thirdOctet}.${hostOctet}`;
}

function validatePool(pool: NodePool): void {
  if (!Number.isInteger(pool.count) || pool.count < 0) {
    throw new Error(`Node pool ${pool.name} count must be a non-negative integer`);
  }
  if (pool.provider === 'dedicated' && pool.count > 0) {
    for (const [name, value] of [
      ['plan', pool.plan],
      ['operatingSystem', pool.operatingSystem],
      ['datacenter', pool.datacenter],
      ['orderRegion', pool.orderRegion]
    ] as const) {
      if (!value.trim()) {
        throw new Error(`Enabled dedicated pool ${pool.name} requires ${name}`);
      }
    }
  }
}

export function normalizeNodePools(
  pools: readonly NodePool[],
  stage: string,
  cidr: string
): TopologyResult {
  parse16Cidr(cidr);
  const names = new Set<string>();
  const ips = new Set<string>();
  const nodes: ClusterNodeSpec[] = [];

  for (const pool of pools) {
    validatePool(pool);
    if (names.has(pool.name)) {
      throw new Error(`Duplicate node pool name: ${pool.name}`);
    }
    names.add(pool.name);
    const identity = NODE_POOL_IDENTITIES[pool.name];
    const allocation = CLUSTER_ADDRESS_PLAN[pool.name];
    const allocationStart = formatClusterIp(cidr, allocation.thirdOctet, allocation.start);
    const allocationEnd = formatClusterIp(cidr, allocation.thirdOctet, allocation.end);
    const allocationCapacity = allocation.end - allocation.start + 1;
    if (pool.count > allocationCapacity) {
      throw new Error(
        `Node pool ${pool.name} allocation count ${pool.count} exceeds ` +
          `${allocationStart}-${allocationEnd}`
      );
    }

    for (let poolIndex = 0; poolIndex < pool.count; poolIndex += 1) {
      const privateIp = formatClusterIp(cidr, allocation.thirdOctet, allocation.start + poolIndex);
      if (ips.has(privateIp)) {
        throw new Error(`Duplicate private IP: ${privateIp}`);
      }
      ips.add(privateIp);
      nodes.push({
        pool,
        poolIndex,
        logicalName: `${identity.logicalNamePrefix}${poolIndex}`,
        hostname: `${stage}-ovh-${identity.hostnamePrefix}-${poolIndex}`,
        privateIp,
        role: pool.role,
        provider: pool.provider,
        ingress: pool.ingress,
        bootstrapCandidate: false
      });
    }
  }

  const controlPlanes = nodes.filter((node) => node.role === 'control-plane');
  if (nodes.length > 0 && controlPlanes.length === 0) {
    throw new Error('Cluster nodes require at least one control-plane node');
  }
  const infrastructureAllocationCapacity =
    CLUSTER_ADDRESS_PLAN.infrastructure.end - CLUSTER_ADDRESS_PLAN.infrastructure.start + 1;
  const infrastructureAllocationDemand = getClusterInfrastructureAllocationDemand(nodes);
  if (infrastructureAllocationDemand > infrastructureAllocationCapacity) {
    const infrastructureStart = formatClusterIp(
      cidr,
      CLUSTER_ADDRESS_PLAN.infrastructure.thirdOctet,
      CLUSTER_ADDRESS_PLAN.infrastructure.start
    );
    const infrastructureEnd = formatClusterIp(
      cidr,
      CLUSTER_ADDRESS_PLAN.infrastructure.thirdOctet,
      CLUSTER_ADDRESS_PLAN.infrastructure.end
    );
    throw new Error(
      `Cluster topology requires ${infrastructureAllocationDemand} Neutron infrastructure ` +
        `addresses, but ${cidr} provides ${infrastructureAllocationCapacity} in ` +
        `${infrastructureStart}-${infrastructureEnd}`
    );
  }
  if (controlPlanes.length > CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY) {
    throw new Error(
      `The single private API load balancer supports at most ` +
        `${CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY} control-plane members; configured ` +
        `${controlPlanes.length}`
    );
  }
  if (controlPlanes[0]) {
    controlPlanes[0].bootstrapCandidate = true;
  }

  const warnings: string[] = [];
  if (controlPlanes.length > 0 && (controlPlanes.length < 3 || controlPlanes.length % 2 === 0)) {
    warnings.push(
      `Embedded-etcd HA recommends an odd control-plane count of at least 3; configured ${controlPlanes.length}`
    );
  }

  return { nodes, warnings };
}

export function getClusterInfrastructureAllocationDemand(
  nodes: readonly Pick<ClusterNodeSpec, 'provider' | 'role' | 'ingress'>[]
): number {
  const privateApiVips = nodes.some((node) => node.role === 'control-plane') ? 1 : 0;
  const ingressNodes = nodes.filter((node) => node.ingress).length;
  const publicIngressVips =
    Math.ceil(ingressNodes / CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY) *
    CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP;

  return CLUSTER_NETWORK_INFRASTRUCTURE_CONSUMERS + privateApiVips + publicIngressVips;
}
