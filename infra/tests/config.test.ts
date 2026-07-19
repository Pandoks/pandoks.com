import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import type * as ClusterConfigModule from '../cluster/config.ts';

Object.defineProperty(globalThis, '$app', {
  configurable: true,
  value: { stage: 'production' }
});

const jiti = createJiti(import.meta.url);
const {
  GATEWAY_MODEL,
  LOAD_BALANCER_ALGORITHM,
  LOAD_BALANCER_FLAVOR,
  NODE_POOLS,
  NON_PRODUCTION_CLUSTER_CONFIG,
  PRODUCTION_CLUSTER_CONFIG,
  REGION,
  clusterConfig,
  clusterNodeCount
} = await jiti.import<typeof ClusterConfigModule>('../cluster/config.ts');

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
  assert.equal(clusterConfig, PRODUCTION_CLUSTER_CONFIG);
});

void test('keeps non-production compute disabled until code review enables it', () => {
  assert.deepEqual(NON_PRODUCTION_CLUSTER_CONFIG, emptyConfig);
});

void test('owns the shared OVH topology settings in the cluster configuration', () => {
  assert.equal(REGION, 'US-WEST-OR-1');
  assert.equal(GATEWAY_MODEL, 's');
  assert.equal(LOAD_BALANCER_FLAVOR, 'small');
  assert.equal(LOAD_BALANCER_ALGORITHM, 'leastConnections');
  assert.deepEqual(
    NODE_POOLS.map(({ name, count }) => ({ name, count })),
    [
      { name: 'cloud-control-plane', count: 0 },
      { name: 'cloud-workers', count: 0 },
      { name: 'dedicated-control-plane', count: 0 },
      { name: 'dedicated-workers', count: 0 }
    ]
  );
  assert.equal(clusterNodeCount, 0);
});
