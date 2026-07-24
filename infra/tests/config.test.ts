import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GATEWAY_MODEL,
  LOAD_BALANCER_ALGORITHM,
  LOAD_BALANCER_FLAVOR,
  NON_PRODUCTION_CLUSTER_CONFIG,
  OVH_ACCOUNT,
  PRODUCTION_CLUSTER_CONFIG,
  type ClusterSpec,
  type NodePoolConfig,
  type PublicIngressConfig
} from '../cluster/config.ts';

const configs = [PRODUCTION_CLUSTER_CONFIG, NON_PRODUCTION_CLUSTER_CONFIG];

void test('starts every stage with zero declared clusters and shared defaults', () => {
  for (const config of configs) {
    assert.deepEqual(config.clusters, []);
    assert.deepEqual(config.interconnect, { vlanId: 4000, cidr: '172.16.0.0/12' });
    assert.deepEqual(config.publicIngress, { type: 'public-cloud', flavor: 'small' });
  }
});

void test('keeps the cluster configuration pure and free of stage helpers', () => {
  const source = readFileSync('infra/cluster/config.ts', 'utf8');
  assert.doesNotMatch(source, /\$app|\.\.\/utils|isProduction/);
});

void test('collapses to the single US OVH account', () => {
  assert.deepEqual(OVH_ACCOUNT, {
    endpoint: 'ovh-us',
    apiRoot: 'https://api.us.ovhcloud.com/1.0',
    subsidiary: 'US',
    applicationKey: 'edf9a4672d28e3c7',
    applicationSecretEnvironment: 'OVH_APPLICATION_SECRET',
    consumerKeyEnvironment: 'OVH_CONSUMER_KEY'
  });
  assert.equal(GATEWAY_MODEL, 'S');
  assert.equal(LOAD_BALANCER_FLAVOR, 'small');
  assert.equal(LOAD_BALANCER_ALGORITHM, 'leastConnections');

  const source = readFileSync('infra/cluster/config.ts', 'utf8');
  assert.doesNotMatch(source, /OVH_ACCOUNTS|ovh-eu|OVH_EU_/);
});

void test('models clusters as free-form primitives instead of fixed regional slots', () => {
  const source = readFileSync('infra/cluster/config.ts', 'utf8');
  assert.doesNotMatch(source, /ClusterRegionKey|OvhAccountKey|NodePoolName|type Workload|enabled:/);
  assert.match(source, /export type PublicCloudRegion/);
  assert.match(source, /export type DedicatedDatacenter/);
  assert.match(source, /type: 'public-cloud'; flavor: string/);

  const pool: NodePoolConfig = {
    name: 'database',
    role: 'worker',
    count: 1,
    labels: { 'pandoks.com/workload': 'database' },
    taints: [{ key: 'pandoks.com/workload', value: 'database', effect: 'NoSchedule' }],
    server: { type: 'public-cloud', region: 'US-WEST-OR-1', flavor: 'b3-8', image: 'Ubuntu 26.04' }
  };
  const swapped: NodePoolConfig = {
    ...pool,
    server: {
      type: 'dedicated',
      datacenter: 'vin',
      planCode: 'future-catalog-plan',
      operatingSystem: 'ubuntu2604-server_64',
      orderRegion: 'usa',
      planOptions: []
    }
  };
  const cluster: ClusterSpec = { name: 'anywhere', networkIndex: 3, pools: [pool, swapped] };
  const ingress: PublicIngressConfig = { type: 'public-cloud', flavor: 'runtime-catalog-flavor' };
  assert.equal(cluster.pools[0].server.type, 'public-cloud');
  assert.equal(cluster.pools[1].server.type, 'dedicated');
  assert.equal(ingress.type, 'public-cloud');
});
