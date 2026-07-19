import { isProduction } from '../utils';
import type { DedicatedPlanOption, NodePool } from './types';

export type GatewayModel = 's' | 'm' | 'l' | 'xl' | '2xl' | '3xl';
export type LoadBalancerFlavor = 'small' | 'medium' | 'large' | 'xl';
export type LoadBalancerAlgorithm = 'leastConnections' | 'roundRobin' | 'sourceIP';

export const REGION = 'US-WEST-OR-1';
export const GATEWAY_MODEL: GatewayModel = 's';
export const LOAD_BALANCER_FLAVOR: LoadBalancerFlavor = 'small';
export const LOAD_BALANCER_ALGORITHM: LoadBalancerAlgorithm = 'leastConnections';

export type ClusterStageConfig = {
  cloudControlPlaneCount: number;
  cloudWorkerCount: number;
  dedicatedControlPlaneCount: number;
  dedicatedWorkerCount: number;
  dedicatedPlan: string;
  dedicatedDatacenter: string;
  dedicatedOrderRegion: string;
  dedicatedPlanOptions: DedicatedPlanOption[];
};

export const PRODUCTION_CLUSTER_CONFIG: ClusterStageConfig = {
  cloudControlPlaneCount: 0,
  cloudWorkerCount: 0,
  dedicatedControlPlaneCount: 0,
  dedicatedWorkerCount: 0,
  dedicatedPlan: '',
  dedicatedDatacenter: '',
  dedicatedOrderRegion: '',
  dedicatedPlanOptions: []
};

export const NON_PRODUCTION_CLUSTER_CONFIG: ClusterStageConfig = {
  cloudControlPlaneCount: 0,
  cloudWorkerCount: 0,
  dedicatedControlPlaneCount: 0,
  dedicatedWorkerCount: 0,
  dedicatedPlan: '',
  dedicatedDatacenter: '',
  dedicatedOrderRegion: '',
  dedicatedPlanOptions: []
};

export const clusterConfig = isProduction
  ? PRODUCTION_CLUSTER_CONFIG
  : NON_PRODUCTION_CLUSTER_CONFIG;

export const NODE_POOLS: readonly NodePool[] = [
  {
    name: 'cloud-control-plane',
    provider: 'public-cloud',
    role: 'control-plane',
    count: clusterConfig.cloudControlPlaneCount,
    ingress: true,
    flavor: 'b3-8',
    image: 'Ubuntu 24.04',
    region: REGION
  },
  {
    name: 'cloud-workers',
    provider: 'public-cloud',
    role: 'worker',
    count: clusterConfig.cloudWorkerCount,
    ingress: true,
    flavor: 'b3-8',
    image: 'Ubuntu 24.04',
    region: REGION
  },
  {
    name: 'dedicated-control-plane',
    provider: 'dedicated',
    role: 'control-plane',
    count: clusterConfig.dedicatedControlPlaneCount,
    ingress: true,
    plan: clusterConfig.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: clusterConfig.dedicatedDatacenter,
    orderRegion: clusterConfig.dedicatedOrderRegion,
    planOptions: clusterConfig.dedicatedPlanOptions
  },
  {
    name: 'dedicated-workers',
    provider: 'dedicated',
    role: 'worker',
    count: clusterConfig.dedicatedWorkerCount,
    ingress: true,
    plan: clusterConfig.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: clusterConfig.dedicatedDatacenter,
    orderRegion: clusterConfig.dedicatedOrderRegion,
    planOptions: clusterConfig.dedicatedPlanOptions
  }
];

export const clusterNodeCount = NODE_POOLS.reduce((total, pool) => total + pool.count, 0);
