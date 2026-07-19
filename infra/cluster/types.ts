export type NodeProvider = 'public-cloud' | 'dedicated';
export type NodeRole = 'control-plane' | 'worker';
export type NodePoolName =
  | 'cloud-control-plane'
  | 'cloud-workers'
  | 'dedicated-control-plane'
  | 'dedicated-workers';

export const CLUSTER_ADDRESS_PLAN = {
  dhcp: { start: 2, end: 99 },
  metalLb: { start: 100, end: 149 },
  'cloud-control-plane': { start: 10, end: 49 },
  'cloud-workers': { start: 50, end: 99 },
  'dedicated-control-plane': { start: 150, end: 199 },
  'dedicated-workers': { start: 200, end: 254 }
} as const satisfies Readonly<Record<'dhcp' | 'metalLb' | NodePoolName, AddressRange>>;

export const CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY = 25;
export const CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP = 1;
// Reserve one DHCP-pool address for the subnet's DHCP service port and one for
// the gateway/router port. This is intentionally conservative and is included
// even for an empty compute topology because the shared network still exists.
export const CLUSTER_NETWORK_DHCP_CONSUMERS = 2;

type AddressRange = {
  start: number;
  end: number;
};

type NodePoolBase = {
  name: NodePoolName;
  provider: NodeProvider;
  role: NodeRole;
  count: number;
  ingress: boolean;
  privateIpStart: number;
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

export function isClusterNodeProtected(
  node: Pick<ClusterNodeSpec, 'logicalName' | 'pool' | 'poolIndex'>,
  unprotectedLogicalName: string,
  isProduction: boolean
): boolean {
  const isHighestIndex = node.poolIndex === node.pool.count - 1;
  return isProduction && (!isHighestIndex || node.logicalName !== unprotectedLogicalName);
}

export function getUnprotectedNodeWarning(
  nodes: readonly Pick<ClusterNodeSpec, 'logicalName' | 'pool' | 'poolIndex'>[],
  unprotectedLogicalName: string
): string | undefined {
  if (
    !unprotectedLogicalName ||
    nodes.some(
      (node) =>
        node.logicalName === unprotectedLogicalName && node.poolIndex === node.pool.count - 1
    )
  ) {
    return undefined;
  }
  return (
    `OVH_UNPROTECTED_NODE_LOGICAL_NAME=${unprotectedLogicalName} does not match a currently ` +
    'declared highest-index node; clear it after the targeted deletion is complete'
  );
}

function parse24Cidr(cidr: string): string {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/.exec(cidr);
  if (!match) {
    throw new Error(`Cluster CIDR must be an IPv4 /24 ending in .0: ${cidr}`);
  }
  for (const octet of match[1].split('.').map(Number)) {
    if (octet < 0 || octet > 255) {
      throw new Error(`Cluster CIDR contains an invalid octet: ${cidr}`);
    }
  }
  return match[1];
}

function validatePool(pool: NodePool): void {
  if (!Number.isInteger(pool.count) || pool.count < 0) {
    throw new Error(`Node pool ${pool.name} count must be a non-negative integer`);
  }
  if (!Number.isInteger(pool.privateIpStart)) {
    throw new Error(`Node pool ${pool.name} privateIpStart must be an integer`);
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
  const subnetPrefix = parse24Cidr(cidr);
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

    for (let poolIndex = 0; poolIndex < pool.count; poolIndex += 1) {
      const hostOctet = pool.privateIpStart + poolIndex;
      if (hostOctet < 2 || hostOctet > 254) {
        throw new Error(
          `Node pool ${pool.name} allocates an address outside ${cidr}: ${hostOctet}`
        );
      }
      if (
        hostOctet >= CLUSTER_ADDRESS_PLAN.metalLb.start &&
        hostOctet <= CLUSTER_ADDRESS_PLAN.metalLb.end
      ) {
        throw new Error(
          `Node pool ${pool.name} cannot allocate ${subnetPrefix}.${hostOctet} from the ` +
            `MetalLB range ${subnetPrefix}.${CLUSTER_ADDRESS_PLAN.metalLb.start}-` +
            `${subnetPrefix}.${CLUSTER_ADDRESS_PLAN.metalLb.end}`
        );
      }
      const allocation = CLUSTER_ADDRESS_PLAN[pool.name];
      if (hostOctet < allocation.start || hostOctet > allocation.end) {
        throw new Error(
          `Node pool ${pool.name} allocation ${subnetPrefix}.${allocation.start}-` +
            `${subnetPrefix}.${allocation.end} cannot include ${subnetPrefix}.${hostOctet}`
        );
      }
      const privateIp = `${subnetPrefix}.${hostOctet}`;
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
  const dhcpAllocationCapacity =
    CLUSTER_ADDRESS_PLAN.dhcp.end - CLUSTER_ADDRESS_PLAN.dhcp.start + 1;
  const dhcpAllocationDemand = getClusterDhcpAllocationDemand(nodes);
  if (dhcpAllocationDemand > dhcpAllocationCapacity) {
    throw new Error(
      `Cluster topology requires ${dhcpAllocationDemand} Neutron DHCP allocation addresses, ` +
        `but ${cidr} provides ${dhcpAllocationCapacity} in ` +
        `${subnetPrefix}.${CLUSTER_ADDRESS_PLAN.dhcp.start}-` +
        `${subnetPrefix}.${CLUSTER_ADDRESS_PLAN.dhcp.end}`
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

export function getClusterDhcpAllocationDemand(
  nodes: readonly Pick<ClusterNodeSpec, 'provider' | 'role' | 'ingress'>[]
): number {
  const publicCloudFixedIps = nodes.filter((node) => node.provider === 'public-cloud').length;
  const privateApiVips = nodes.some((node) => node.role === 'control-plane') ? 1 : 0;
  const ingressNodes = nodes.filter((node) => node.ingress).length;
  const publicIngressVips =
    Math.ceil(ingressNodes / CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY) *
    CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP;

  return publicCloudFixedIps + CLUSTER_NETWORK_DHCP_CONSUMERS + privateApiVips + publicIngressVips;
}
