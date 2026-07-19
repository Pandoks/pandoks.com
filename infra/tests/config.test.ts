import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NON_PRODUCTION_CLUSTER_CONFIG,
  PRODUCTION_CLUSTER_CONFIG,
  getClusterStageConfig,
  shouldProvisionClusterInfrastructure
} from '../cluster/config.ts';

const emptyConfig = {
  cloudControlPlaneCount: 0,
  cloudWorkerCount: 0,
  dedicatedControlPlaneCount: 0,
  dedicatedWorkerCount: 0,
  dedicatedPlan: '',
  dedicatedDatacenter: '',
  dedicatedOrderRegion: '',
  dedicatedPlanOptions: []
};

void test('keeps production compute disabled until code review enables it', () => {
  assert.deepEqual(PRODUCTION_CLUSTER_CONFIG, emptyConfig);
  assert.equal(getClusterStageConfig(true), PRODUCTION_CLUSTER_CONFIG);
});

void test('keeps non-production compute disabled until code review enables it', () => {
  assert.deepEqual(NON_PRODUCTION_CLUSTER_CONFIG, emptyConfig);
  assert.equal(getClusterStageConfig(false), NON_PRODUCTION_CLUSTER_CONFIG);
});

void test('skips only empty non-production cluster infrastructure', () => {
  assert.equal(shouldProvisionClusterInfrastructure(true, PRODUCTION_CLUSTER_CONFIG), true);
  assert.equal(shouldProvisionClusterInfrastructure(false, NON_PRODUCTION_CLUSTER_CONFIG), false);
  assert.equal(
    shouldProvisionClusterInfrastructure(false, {
      ...NON_PRODUCTION_CLUSTER_CONFIG,
      cloudWorkerCount: 1
    }),
    true
  );
});
