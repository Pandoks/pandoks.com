import { isProduction } from '../utils';
import type { DedicatedPlanOption, NodePool, NodePoolName, NodeRole, Workload } from './topology';

type GatewayModel = 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';
type LoadBalancerFlavor = 'small' | 'medium' | 'large' | 'xl';
type LoadBalancerAlgorithm = 'leastConnections' | 'roundRobin' | 'sourceIP';

export const REGION = 'US-WEST-OR-1';
export const CLOUD_IMAGE = 'Ubuntu 26.04';
export const DEDICATED_OPERATING_SYSTEM = 'ubuntu2604-server_64';
export const DEDICATED_DATACENTER = '';
export const DEDICATED_ORDER_REGION = '';
export const GATEWAY_MODEL: GatewayModel = 'S';
export const LOAD_BALANCER_FLAVOR: LoadBalancerFlavor = 'small';
export const LOAD_BALANCER_ALGORITHM: LoadBalancerAlgorithm = 'leastConnections';

type PoolConfig = {
  name: NodePoolName;
  role: NodeRole;
  workload: Workload;
  count: number;
  publicIngress: boolean;
  machineType: string;
};

export type CloudPoolConfig = PoolConfig;
export type DedicatedPoolConfig = PoolConfig & {
  planOptions: DedicatedPlanOption[];
};

export type ClusterConfig = {
  cloud: readonly CloudPoolConfig[];
  dedicated: readonly DedicatedPoolConfig[];
  loadBalancerCount: number;
};

const CLOUD_POOLS = [
  {
    name: 'cloud-control-plane',
    role: 'control-plane',
    workload: 'general',
    count: 0,
    publicIngress: true,
    machineType: 'b3-8'
  },
  {
    name: 'cloud-workers',
    role: 'worker',
    workload: 'general',
    count: 0,
    publicIngress: true,
    machineType: 'b3-8'
  },
  {
    name: 'cloud-database',
    role: 'worker',
    workload: 'database',
    count: 0,
    publicIngress: false,
    machineType: 'b3-8'
  }
] satisfies readonly CloudPoolConfig[];

const DEDICATED_POOLS = [
  {
    name: 'dedicated-control-plane',
    role: 'control-plane',
    workload: 'general',
    count: 0,
    publicIngress: true,
    machineType: '',
    planOptions: []
  },
  {
    name: 'dedicated-workers',
    role: 'worker',
    workload: 'general',
    count: 0,
    publicIngress: true,
    machineType: '',
    planOptions: []
  },
  {
    name: 'dedicated-database',
    role: 'worker',
    workload: 'database',
    count: 0,
    publicIngress: false,
    machineType: '',
    planOptions: []
  }
] satisfies readonly DedicatedPoolConfig[];

export const PRODUCTION_CLUSTER_CONFIG: ClusterConfig = {
  cloud: CLOUD_POOLS,
  dedicated: DEDICATED_POOLS,
  loadBalancerCount: 0
};

export const NON_PRODUCTION_CLUSTER_CONFIG: ClusterConfig = {
  cloud: CLOUD_POOLS,
  dedicated: DEDICATED_POOLS,
  loadBalancerCount: 0
};

export const clusterConfig = isProduction
  ? PRODUCTION_CLUSTER_CONFIG
  : NON_PRODUCTION_CLUSTER_CONFIG;

export const NODE_POOLS: readonly NodePool[] = [
  ...clusterConfig.cloud.map((pool) => ({
    ...pool,
    provider: 'public-cloud' as const,
    image: CLOUD_IMAGE,
    region: REGION
  })),
  ...clusterConfig.dedicated.map((pool) => ({
    ...pool,
    provider: 'dedicated' as const,
    operatingSystem: DEDICATED_OPERATING_SYSTEM,
    datacenter: DEDICATED_DATACENTER,
    orderRegion: DEDICATED_ORDER_REGION
  }))
];
