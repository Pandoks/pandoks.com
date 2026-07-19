import type { DedicatedPlanOption } from './types';

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

export function getClusterNodeCount(config: ClusterStageConfig): number {
  return (
    config.cloudControlPlaneCount +
    config.cloudWorkerCount +
    config.dedicatedControlPlaneCount +
    config.dedicatedWorkerCount
  );
}

export function shouldProvisionClusterInfrastructure(
  isProduction: boolean,
  config: ClusterStageConfig
): boolean {
  return isProduction || getClusterNodeCount(config) > 0;
}
