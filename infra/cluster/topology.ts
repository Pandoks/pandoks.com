// Stable partitions within the single OVH 10.0.0.0/16 subnet:
// 10.0.0.x        OVH/Neutron infrastructure
// 10.0.1.x        Public Cloud control planes
// 10.0.2.x        Public Cloud workers
// 10.0.3.x        Dedicated control planes
// 10.0.4.x        Dedicated workers
// 10.0.5.x        MetalLB services
// 10.0.6.x        Public Cloud database workers
// 10.0.7.x        Dedicated database workers
// 10.0.8-255.x    Reserved for future pools
// Never renumber or reuse an existing entry: pool order and count changes must
// not readdress nodes.
const NODE_POOL_IDENTITIES = {
  'cloud-control-plane': {
    addressBlock: 1,
    logicalNamePrefix: 'OvhControlPlaneServer',
    hostnamePrefix: 'control-plane-server'
  },
  'cloud-workers': {
    addressBlock: 2,
    logicalNamePrefix: 'OvhWorkerServer',
    hostnamePrefix: 'worker-server'
  },
  'dedicated-control-plane': {
    addressBlock: 3,
    logicalNamePrefix: 'OvhDedicatedControlPlaneServer',
    hostnamePrefix: 'dedicated-control-plane-server'
  },
  'dedicated-workers': {
    addressBlock: 4,
    logicalNamePrefix: 'OvhDedicatedWorkerServer',
    hostnamePrefix: 'dedicated-worker-server'
  },
  'cloud-database': {
    addressBlock: 6,
    logicalNamePrefix: 'OvhDatabaseServer',
    hostnamePrefix: 'database-server'
  },
  'dedicated-database': {
    addressBlock: 7,
    logicalNamePrefix: 'OvhDedicatedDatabaseServer',
    hostnamePrefix: 'dedicated-database-server'
  }
} as const;

export type NodePoolName = keyof typeof NODE_POOL_IDENTITIES;
export type NodeRole = 'control-plane' | 'worker';
export type Workload = 'general' | 'database';

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

export type DedicatedPlanOption = {
  duration: string;
  planCode: string;
  pricingMode: string;
  quantity: number;
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
  mode: 'none' | 'direct' | 'ovh' | 'cloudflare';
  nodes: readonly ClusterNodeSpec[];
  loadBalancerCount: number;
};

export type PrivateApiPlan = {
  mode: 'none' | 'direct' | 'ovh';
  nodes: readonly ClusterNodeSpec[];
};

function validatePool(pool: NodePool): void {
  if (!Number.isInteger(pool.count) || pool.count < 0) {
    throw new Error(`Node pool ${pool.name} count must be a non-negative integer`);
  }
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
    for (const [name, value] of [
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

export function buildClusterPlan(
  pools: readonly NodePool[],
  stage: string,
  publicIngressLoadBalancerCount: number
) {
  if (!Number.isInteger(publicIngressLoadBalancerCount) || publicIngressLoadBalancerCount < 0) {
    throw new Error('publicIngressLoadBalancerCount must be a non-negative integer');
  }

  const names = new Set<string>();
  const nodes: ClusterNodeSpec[] = [];

  for (const pool of pools) {
    validatePool(pool);
    if (names.has(pool.name)) {
      throw new Error(`Duplicate node pool name: ${pool.name}`);
    }
    names.add(pool.name);
    const identity = NODE_POOL_IDENTITIES[pool.name];
    if (!identity) {
      throw new Error(`Unknown node pool: ${pool.name}`);
    }
    const { addressBlock, hostnamePrefix, logicalNamePrefix } = identity;
    if (pool.count > 254) {
      throw new Error(
        `Node pool ${pool.name} count ${pool.count} exceeds ` +
          `10.0.${addressBlock}.1-10.0.${addressBlock}.254`
      );
    }

    for (let poolIndex = 0; poolIndex < pool.count; poolIndex += 1) {
      const privateIp = `10.0.${addressBlock}.${poolIndex + 1}`;
      nodes.push({
        pool,
        poolIndex,
        logicalName: `${logicalNamePrefix}${poolIndex}`,
        hostname: `${stage}-ovh-${hostnamePrefix}-${poolIndex}`,
        privateIp,
        bootstrapCandidate: false,
        directIngress: false
      });
    }
  }

  const controlPlanes = nodes.filter((node) => node.pool.role === 'control-plane');
  if (nodes.length > 0 && controlPlanes.length === 0) {
    throw new Error('Cluster nodes require at least one control-plane node');
  }
  if (controlPlanes[0]) {
    controlPlanes[0].bootstrapCandidate = true;
  }

  const privateApi: PrivateApiPlan = {
    mode: controlPlanes.length === 0 ? 'none' : controlPlanes.length === 1 ? 'direct' : 'ovh',
    nodes: controlPlanes
  };

  const ingressNodes = nodes.filter((node) => node.pool.publicIngress);
  if (ingressNodes.length === 0 && publicIngressLoadBalancerCount !== 0) {
    throw new Error('no ingress nodes requires publicIngressLoadBalancerCount to be 0');
  }
  if (ingressNodes.length === 1 && publicIngressLoadBalancerCount !== 0) {
    throw new Error('one ingress node requires publicIngressLoadBalancerCount to be 0');
  }
  if (ingressNodes.length > 1 && publicIngressLoadBalancerCount === 0) {
    throw new Error('multiple ingress nodes require at least one public ingress load balancer');
  }
  if (ingressNodes.length === 1) ingressNodes[0].directIngress = true;

  const publicIngress: PublicIngressPlan = {
    mode:
      ingressNodes.length === 0
        ? 'none'
        : ingressNodes.length === 1
          ? 'direct'
          : publicIngressLoadBalancerCount === 1
            ? 'ovh'
            : 'cloudflare',
    nodes: ingressNodes,
    loadBalancerCount: publicIngressLoadBalancerCount
  };

  const warnings: string[] = [];
  if (controlPlanes.length > 0 && (controlPlanes.length < 3 || controlPlanes.length % 2 === 0)) {
    warnings.push(
      `Embedded-etcd HA recommends an odd control-plane count of at least 3; configured ${controlPlanes.length}`
    );
  }
  return { nodes, warnings, privateApi, publicIngress };
}

// Retained for the documented future highest-index-first scale-down workflow.
export function getPoolScaleDownTarget(pool: NodePool, stage: string) {
  if (pool.count < 1) {
    throw new Error(`Node pool ${pool.name} has no node to remove`);
  }
  const { hostnamePrefix, logicalNamePrefix } = NODE_POOL_IDENTITIES[pool.name];
  const index = pool.count - 1;
  return {
    index,
    logicalName: `${logicalNamePrefix}${index}`,
    hostname: `${stage}-ovh-${hostnamePrefix}-${index}`
  };
}
