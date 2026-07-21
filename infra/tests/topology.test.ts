import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClusterPlan, getPoolScaleDownTarget, type NodePool } from '../cluster/topology.ts';

const cloudControlPlane = {
  name: 'cloud-control-plane',
  provider: 'public-cloud',
  role: 'control-plane',
  count: 1,
  ingress: true,
  logicalNamePrefix: 'OvhControlPlaneServer',
  hostnamePrefix: 'control-plane-server',
  flavor: 'b3-8',
  image: 'Ubuntu 24.04',
  region: 'US-WEST-OR-1'
} satisfies NodePool;

const dedicatedControlPlane = {
  name: 'dedicated-control-plane',
  provider: 'dedicated',
  role: 'control-plane',
  count: 2,
  ingress: true,
  logicalNamePrefix: 'OvhDedicatedControlPlaneServer',
  hostnamePrefix: 'dedicated-control-plane-server',
  plan: '24rise01',
  operatingSystem: 'ubuntu2404-server_64',
  datacenter: 'bhs',
  orderRegion: 'canada',
  planOptions: []
} satisfies NodePool;

const cloudWorkers = (count: number) =>
  ({
    ...cloudControlPlane,
    name: 'cloud-workers',
    role: 'worker',
    count,
    logicalNamePrefix: 'OvhWorkerServer',
    hostnamePrefix: 'worker-server'
  }) satisfies NodePool;

const dedicatedWorkers = (count: number) =>
  ({
    ...dedicatedControlPlane,
    name: 'dedicated-workers',
    role: 'worker',
    count,
    logicalNamePrefix: 'OvhDedicatedWorkerServer',
    hostnamePrefix: 'dedicated-worker-server'
  }) satisfies NodePool;

void test('builds stable identities and role-owned addresses for mixed providers', () => {
  const result = buildClusterPlan(
    [cloudControlPlane, cloudWorkers(1), dedicatedControlPlane, dedicatedWorkers(1)],
    'prod',
    1
  );

  assert.deepEqual(
    result.nodes.map(({ logicalName, hostname, privateIp, bootstrapCandidate }) => ({
      logicalName,
      hostname,
      privateIp,
      bootstrapCandidate
    })),
    [
      {
        logicalName: 'OvhControlPlaneServer0',
        hostname: 'prod-ovh-control-plane-server-0',
        privateIp: '10.0.1.1',
        bootstrapCandidate: true
      },
      {
        logicalName: 'OvhWorkerServer0',
        hostname: 'prod-ovh-worker-server-0',
        privateIp: '10.0.2.1',
        bootstrapCandidate: false
      },
      {
        logicalName: 'OvhDedicatedControlPlaneServer0',
        hostname: 'prod-ovh-dedicated-control-plane-server-0',
        privateIp: '10.0.3.1',
        bootstrapCandidate: false
      },
      {
        logicalName: 'OvhDedicatedControlPlaneServer1',
        hostname: 'prod-ovh-dedicated-control-plane-server-1',
        privateIp: '10.0.3.2',
        bootstrapCandidate: false
      },
      {
        logicalName: 'OvhDedicatedWorkerServer0',
        hostname: 'prod-ovh-dedicated-worker-server-0',
        privateIp: '10.0.4.1',
        bootstrapCandidate: false
      }
    ]
  );
  assert.deepEqual(result.warnings, []);
});

void test('chooses the first available control plane as bootstrap candidate', () => {
  const result = buildClusterPlan([{ ...dedicatedControlPlane, count: 1 }], 'prod', 0);
  assert.equal(result.nodes[0]?.bootstrapCandidate, true);
});

void test('uses a direct API target for one control plane and an OVH VIP for multiple', () => {
  const direct = buildClusterPlan([cloudControlPlane], 'prod', 0);
  assert.equal(direct.privateApi.mode, 'direct');
  assert.deepEqual(direct.privateApi.nodes, [direct.nodes[0]]);

  const balanced = buildClusterPlan([cloudControlPlane, dedicatedControlPlane], 'prod', 1);
  assert.equal(balanced.privateApi.mode, 'ovh');
  assert.deepEqual(
    balanced.privateApi.nodes.map(({ privateIp }) => privateIp),
    ['10.0.1.1', '10.0.3.1', '10.0.3.2']
  );

  assert.equal(buildClusterPlan([], 'prod', 0).privateApi.mode, 'none');
});

void test('resource identity and private IP are independent of pool ordering', () => {
  const first = buildClusterPlan([cloudControlPlane, dedicatedControlPlane], 'prod', 1);
  const second = buildClusterPlan([dedicatedControlPlane, cloudControlPlane], 'prod', 1);
  assert.deepEqual(
    new Map(first.nodes.map((node) => [node.logicalName, node.privateIp])),
    new Map(second.nodes.map((node) => [node.logicalName, node.privateIp]))
  );
});

void test('count changes only add or remove the highest indexes in that pool', () => {
  const one = buildClusterPlan([cloudControlPlane, cloudWorkers(1)], 'prod', 1);
  const three = buildClusterPlan([cloudControlPlane, cloudWorkers(3)], 'prod', 1);

  assert.deepEqual(
    one.nodes.map(({ logicalName, privateIp }) => ({ logicalName, privateIp })),
    three.nodes.slice(0, 2).map(({ logicalName, privateIp }) => ({ logicalName, privateIp }))
  );
  assert.deepEqual(
    three.nodes.slice(2).map(({ logicalName, privateIp }) => ({ logicalName, privateIp })),
    [
      { logicalName: 'OvhWorkerServer1', privateIp: '10.0.2.2' },
      { logicalName: 'OvhWorkerServer2', privateIp: '10.0.2.3' }
    ]
  );
});

void test('removing and re-adding a pool does not renumber unrelated pools', () => {
  const allPools = [cloudControlPlane, cloudWorkers(2), dedicatedControlPlane] as const;
  const before = buildClusterPlan(allPools, 'prod', 1);
  const withoutCloudWorkers = buildClusterPlan(
    [cloudControlPlane, dedicatedControlPlane],
    'prod',
    1
  );
  const after = buildClusterPlan(allPools, 'prod', 1);
  const identities = (nodes: typeof before.nodes) =>
    new Map(nodes.map((node) => [node.logicalName, node.privateIp]));

  assert.deepEqual(
    identities(withoutCloudWorkers.nodes),
    new Map([
      ['OvhControlPlaneServer0', '10.0.1.1'],
      ['OvhDedicatedControlPlaneServer0', '10.0.3.1'],
      ['OvhDedicatedControlPlaneServer1', '10.0.3.2']
    ])
  );
  assert.deepEqual(identities(after.nodes), identities(before.nodes));
});

void test('rejects invalid cluster shapes', () => {
  assert.throws(
    () =>
      buildClusterPlan(
        [{ ...cloudControlPlane, name: 'cloud-workers', role: 'worker' }],
        'prod',
        0
      ),
    /at least one control-plane node/
  );
  assert.throws(
    () => buildClusterPlan([cloudControlPlane, cloudControlPlane], 'prod', 1),
    /Duplicate node pool name/
  );
  assert.throws(
    () =>
      buildClusterPlan(
        [
          cloudControlPlane,
          {
            ...dedicatedControlPlane,
            name: 'dedicated-workers',
            role: 'worker',
            count: 255
          }
        ],
        'prod',
        1
      ),
    /dedicated-workers.*10\.0\.4\.1-10\.0\.4\.254/
  );
  assert.throws(
    () =>
      buildClusterPlan(
        [{ ...cloudControlPlane, name: 'unregistered-pool' } as unknown as NodePool],
        'prod',
        0
      ),
    /Unknown node pool: unregistered-pool/
  );
});

void test('accepts every address available to the configured node pools', () => {
  const result = buildClusterPlan(
    [
      { ...cloudControlPlane, count: 254 },
      cloudWorkers(254),
      { ...dedicatedControlPlane, count: 254 },
      dedicatedWorkers(254)
    ],
    'prod',
    1
  );

  assert.equal(result.nodes.length, 1016);
  assert.equal(result.nodes.at(-1)?.privateIp, '10.0.4.254');
});

void test('does not impose a made-up load balancer limit on cluster topology', () => {
  const result = buildClusterPlan(
    [
      { ...cloudControlPlane, count: 13 },
      { ...dedicatedControlPlane, count: 13 }
    ],
    'prod',
    1
  );
  assert.equal(result.nodes.length, 26);
});

void test('validates dedicated catalog settings and embedded-etcd HA', () => {
  assert.throws(
    () => buildClusterPlan([{ ...dedicatedControlPlane, plan: '' }], 'prod', 1),
    /requires plan/
  );
  assert.match(
    buildClusterPlan([cloudControlPlane], 'prod', 0).warnings[0] ?? '',
    /odd control-plane count of at least 3/
  );
});

void test('routes one ingress node directly and forbids a public load balancer', () => {
  const plan = buildClusterPlan([cloudControlPlane], 'dev', 0);
  assert.equal(plan.publicIngress.mode, 'direct');
  assert.equal(plan.publicIngress.nodes[0]?.directIngress, true);
  assert.throws(
    () => buildClusterPlan([cloudControlPlane], 'dev', 1),
    /one ingress node requires publicIngressLoadBalancerCount to be 0/
  );
});

void test('uses direct DNS for one OVH ingress load balancer and Cloudflare for multiple', () => {
  const pools = [cloudControlPlane, dedicatedControlPlane];
  assert.equal(buildClusterPlan(pools, 'prod', 1).publicIngress.mode, 'ovh');
  assert.equal(buildClusterPlan(pools, 'prod', 2).publicIngress.mode, 'cloudflare');
  assert.equal(buildClusterPlan(pools, 'prod', 3).publicIngress.loadBalancerCount, 3);
});

void test('rejects invalid public ingress load balancer counts', () => {
  const pools = [cloudControlPlane, dedicatedControlPlane];
  assert.throws(
    () => buildClusterPlan(pools, 'prod', 0),
    /multiple ingress nodes require at least one public ingress load balancer/
  );
  assert.throws(
    () => buildClusterPlan(pools, 'prod', 1.5),
    /publicIngressLoadBalancerCount must be a non-negative integer/
  );
  assert.throws(
    () => buildClusterPlan([], 'dev', 1),
    /no ingress nodes requires publicIngressLoadBalancerCount to be 0/
  );
  assert.equal(buildClusterPlan([], 'dev', 0).publicIngress.mode, 'none');
});

void test('keeps the scale-down identity template for future operations', () => {
  assert.deepEqual(getPoolScaleDownTarget({ ...dedicatedControlPlane, count: 3 }, 'prod'), {
    index: 2,
    logicalName: 'OvhDedicatedControlPlaneServer2',
    hostname: 'prod-ovh-dedicated-control-plane-server-2'
  });
  assert.throws(
    () => getPoolScaleDownTarget({ ...dedicatedControlPlane, count: 0 }, 'prod'),
    /has no node to remove/
  );
});
