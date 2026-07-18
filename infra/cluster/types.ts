export type NodeProvider = 'public-cloud' | 'dedicated';
export type NodeRole = 'control-plane' | 'worker';

type NodePoolBase = {
  name: 'cloud-control-plane' | 'cloud-workers' | 'dedicated-control-plane' | 'dedicated-workers';
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

export function parseNodeCount(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Node count must be a non-negative integer');
  }
  return parsed;
}

export function parseDedicatedPlanOptions(value: string | undefined): DedicatedPlanOption[] {
  const parsed: unknown = JSON.parse(value?.trim() || '[]');
  if (!Array.isArray(parsed)) {
    throw new Error('OVH_DEDICATED_PLAN_OPTIONS must be a JSON array');
  }
  return parsed.map((option, index) => {
    if (
      typeof option !== 'object' ||
      option === null ||
      !('duration' in option) ||
      !('planCode' in option) ||
      !('pricingMode' in option) ||
      !('quantity' in option) ||
      typeof option.duration !== 'string' ||
      typeof option.planCode !== 'string' ||
      typeof option.pricingMode !== 'string' ||
      typeof option.quantity !== 'number' ||
      !Number.isInteger(option.quantity) ||
      option.quantity < 1
    ) {
      throw new Error(`OVH_DEDICATED_PLAN_OPTIONS[${index}] has an invalid shape`);
    }
    return {
      duration: option.duration,
      planCode: option.planCode,
      pricingMode: option.pricingMode,
      quantity: option.quantity
    };
  });
}

export type DedicatedNodePool = NodePoolBase & {
  provider: 'dedicated';
  plan: string;
  operatingSystem: string;
  datacenter: string;
  orderRegion: string;
  planOptions: readonly DedicatedPlanOption[];
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

const POOL_RESOURCE_PREFIX: Readonly<Record<NodePool['name'], string>> = {
  'cloud-control-plane': 'OvhControlPlaneServer',
  'cloud-workers': 'OvhWorkerServer',
  'dedicated-control-plane': 'OvhDedicatedControlPlaneServer',
  'dedicated-workers': 'OvhDedicatedWorkerServer'
};

const POOL_HOST_PREFIX: Readonly<Record<NodePool['name'], string>> = {
  'cloud-control-plane': 'control-plane-server',
  'cloud-workers': 'worker-server',
  'dedicated-control-plane': 'dedicated-control-plane-server',
  'dedicated-workers': 'dedicated-worker-server'
};

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

    for (let poolIndex = 0; poolIndex < pool.count; poolIndex += 1) {
      const hostOctet = pool.privateIpStart + poolIndex;
      if (hostOctet < 2 || hostOctet > 254) {
        throw new Error(
          `Node pool ${pool.name} allocates an address outside ${cidr}: ${hostOctet}`
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
        logicalName: `${POOL_RESOURCE_PREFIX[pool.name]}${poolIndex}`,
        hostname: `${stage}-ovh-${POOL_HOST_PREFIX[pool.name]}-${poolIndex}`,
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
