import { isProduction } from '../utils';
import type { DedicatedPlanOption, NodePool } from './topology';

type GatewayModel = 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';
type LoadBalancerFlavor = 'small' | 'medium' | 'large' | 'xl';
type LoadBalancerAlgorithm = 'leastConnections' | 'roundRobin' | 'sourceIP';

export const REGION = 'US-WEST-OR-1';
export const GATEWAY_MODEL: GatewayModel = 'S';
export const LOAD_BALANCER_FLAVOR: LoadBalancerFlavor = 'small';
export const LOAD_BALANCER_ALGORITHM: LoadBalancerAlgorithm = 'leastConnections';

type ClusterConfig = {
  cloud: {
    controlPlaneCount: number;
    workerCount: number;
  };
  dedicated: {
    controlPlane: number;
    worker: number;
  };
  loadBalancerCount: number;
  dedicatedPlan: string;
  dedicatedDatacenter: string;
  dedicatedOrderRegion: string;
  dedicatedPlanOptions: DedicatedPlanOption[];
};

export const PRODUCTION_CLUSTER_CONFIG: ClusterConfig = {
  cloud: {
    controlPlaneCount: 0,
    workerCount: 0
  },
  dedicated: {
    controlPlane: 0,
    worker: 0
  },
  loadBalancerCount: 0,
  dedicatedPlan: '',
  dedicatedDatacenter: '',
  dedicatedOrderRegion: '',
  dedicatedPlanOptions: []
};

export const NON_PRODUCTION_CLUSTER_CONFIG: ClusterConfig = {
  cloud: {
    controlPlaneCount: 0,
    workerCount: 0
  },
  dedicated: {
    controlPlane: 0,
    worker: 0
  },
  loadBalancerCount: 0,
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
    count: clusterConfig.cloud.controlPlaneCount,
    ingress: true,
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
    count: clusterConfig.cloud.workerCount,
    ingress: true,
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
    count: clusterConfig.dedicated.controlPlane,
    ingress: true,
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
    count: clusterConfig.dedicated.worker,
    ingress: true,
    logicalNamePrefix: 'OvhDedicatedWorkerServer',
    hostnamePrefix: 'dedicated-worker-server',
    plan: clusterConfig.dedicatedPlan,
    operatingSystem: 'ubuntu2404-server_64',
    datacenter: clusterConfig.dedicatedDatacenter,
    orderRegion: clusterConfig.dedicatedOrderRegion,
    planOptions: clusterConfig.dedicatedPlanOptions
  }
];
