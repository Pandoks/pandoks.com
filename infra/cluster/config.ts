import { isProduction } from '../utils';
import type { DedicatedPlanOption, NodePool } from './topology';

type GatewayModel = 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';
type LoadBalancerFlavor = 'small' | 'medium' | 'large' | 'xl';
type LoadBalancerAlgorithm = 'leastConnections' | 'roundRobin' | 'sourceIP';

export const REGION = 'US-WEST-OR-1';
export const GATEWAY_MODEL: GatewayModel = 'S';
export const LOAD_BALANCER_FLAVOR: LoadBalancerFlavor = 'small';
export const LOAD_BALANCER_ALGORITHM: LoadBalancerAlgorithm = 'leastConnections';

type ClusterStageConfig = {
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
    subnet: 1,
    logicalNamePrefix: 'OvhControlPlaneServer',
    hostnamePrefix: 'control-plane-server',
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
    subnet: 2,
    logicalNamePrefix: 'OvhWorkerServer',
    hostnamePrefix: 'worker-server',
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
    subnet: 3,
    logicalNamePrefix: 'OvhDedicatedControlPlaneServer',
    hostnamePrefix: 'dedicated-control-plane-server',
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
    subnet: 4,
    logicalNamePrefix: 'OvhDedicatedWorkerServer',
    hostnamePrefix: 'dedicated-worker-server',
    plan: clusterConfig.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: clusterConfig.dedicatedDatacenter,
    orderRegion: clusterConfig.dedicatedOrderRegion,
    planOptions: clusterConfig.dedicatedPlanOptions
  }
];
