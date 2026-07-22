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
  CLOUD_IMAGE,
  DEDICATED_DATACENTER,
  DEDICATED_OPERATING_SYSTEM,
  DEDICATED_ORDER_REGION,
  GATEWAY_MODEL,
  LOAD_BALANCER_ALGORITHM,
  LOAD_BALANCER_FLAVOR,
  NODE_POOLS,
  NON_PRODUCTION_CLUSTER_CONFIG,
  PRODUCTION_CLUSTER_CONFIG,
  REGION,
  clusterConfig
} = await jiti.import<typeof ClusterConfigModule>('../cluster/config.ts');

const emptyConfig = {
  cloud: [
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
  ],
  dedicated: [
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
  ],
  loadBalancerCount: 0
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
  assert.equal(CLOUD_IMAGE, 'Ubuntu 26.04');
  assert.equal(DEDICATED_OPERATING_SYSTEM, 'ubuntu2604-server_64');
  assert.equal(DEDICATED_DATACENTER, '');
  assert.equal(DEDICATED_ORDER_REGION, '');
  assert.equal(GATEWAY_MODEL, 'S');
  assert.equal(LOAD_BALANCER_FLAVOR, 'small');
  assert.equal(LOAD_BALANCER_ALGORITHM, 'leastConnections');
  assert.equal(clusterConfig.loadBalancerCount, 0);
  assert.deepEqual(
    NODE_POOLS.map(({ name, provider, role, workload, count, publicIngress, machineType }) => ({
      name,
      provider,
      role,
      workload,
      count,
      publicIngress,
      machineType
    })),
    [
      {
        name: 'cloud-control-plane',
        provider: 'public-cloud',
        role: 'control-plane',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: 'b3-8'
      },
      {
        name: 'cloud-workers',
        provider: 'public-cloud',
        role: 'worker',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: 'b3-8'
      },
      {
        name: 'cloud-database',
        provider: 'public-cloud',
        role: 'worker',
        workload: 'database',
        count: 0,
        publicIngress: false,
        machineType: 'b3-8'
      },
      {
        name: 'dedicated-control-plane',
        provider: 'dedicated',
        role: 'control-plane',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: ''
      },
      {
        name: 'dedicated-workers',
        provider: 'dedicated',
        role: 'worker',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: ''
      },
      {
        name: 'dedicated-database',
        provider: 'dedicated',
        role: 'worker',
        workload: 'database',
        count: 0,
        publicIngress: false,
        machineType: ''
      }
    ]
  );
});
