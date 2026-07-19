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

export function getClusterStageConfig(isProduction: boolean): ClusterStageConfig {
  return isProduction ? PRODUCTION_CLUSTER_CONFIG : NON_PRODUCTION_CLUSTER_CONFIG;
}
