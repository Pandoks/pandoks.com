type NodePoolBase = {
  name: string;
  role: 'control-plane' | 'worker';
  count: number;
  ingress: boolean;
  subnet: number;
  logicalNamePrefix: string;
  hostnamePrefix: string;
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
  bootstrapCandidate: boolean;
  directIngress: boolean;
};

export type PublicIngressPlan = {
  mode: 'none' | 'direct' | 'ovh' | 'cloudflare';
  nodes: readonly ClusterNodeSpec[];
  loadBalancerCount: number;
};

function validatePool(pool: NodePool): void {
  if (!Number.isInteger(pool.count) || pool.count < 0) {
    throw new Error(`Node pool ${pool.name} count must be a non-negative integer`);
  }
  if (!Number.isInteger(pool.subnet) || pool.subnet < 1 || pool.subnet > 255) {
    throw new Error(`Node pool ${pool.name} subnet must be an integer from 1 to 255`);
  }
  if (pool.subnet === 5) {
    throw new Error(`Node pool ${pool.name} subnet 5 is reserved for MetalLB`);
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

export function buildClusterPlan(
  pools: readonly NodePool[],
  stage: string,
  publicIngressLoadBalancerCount: number
) {
  if (!Number.isInteger(publicIngressLoadBalancerCount) || publicIngressLoadBalancerCount < 0) {
    throw new Error('publicIngressLoadBalancerCount must be a non-negative integer');
  }

  const names = new Set<string>();
  const subnets = new Set<number>();
  const nodes: ClusterNodeSpec[] = [];

  for (const pool of pools) {
    validatePool(pool);
    if (names.has(pool.name)) {
      throw new Error(`Duplicate node pool name: ${pool.name}`);
    }
    names.add(pool.name);
    if (subnets.has(pool.subnet)) {
      throw new Error(`Duplicate node pool subnet: ${pool.subnet}`);
    }
    subnets.add(pool.subnet);
    if (pool.count > 254) {
      throw new Error(
        `Node pool ${pool.name} count ${pool.count} exceeds ` +
          `10.0.${pool.subnet}.1-10.0.${pool.subnet}.254`
      );
    }

    for (let poolIndex = 0; poolIndex < pool.count; poolIndex += 1) {
      const privateIp = `10.0.${pool.subnet}.${poolIndex + 1}`;
      nodes.push({
        pool,
        poolIndex,
        logicalName: `${pool.logicalNamePrefix}${poolIndex}`,
        hostname: `${stage}-ovh-${pool.hostnamePrefix}-${poolIndex}`,
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

  const ingressNodes = nodes.filter((node) => node.pool.ingress);
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
  return { nodes, warnings, publicIngress };
}

// Retained for the documented future highest-index-first scale-down workflow.
export function getPoolScaleDownTarget(pool: NodePool, stage: string) {
  if (pool.count < 1) {
    throw new Error(`Node pool ${pool.name} has no node to remove`);
  }
  const index = pool.count - 1;
  return {
    index,
    logicalName: `${pool.logicalNamePrefix}${index}`,
    hostname: `${stage}-ovh-${pool.hostnamePrefix}-${index}`
  };
}
