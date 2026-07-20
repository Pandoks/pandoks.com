import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLUSTER_NETWORK,
  buildClusterPlan,
  getPoolScaleDownTarget,
  type NodePool
} from '../cluster/topology.ts';

const cloudControlPlane = {
  name: 'cloud-control-plane',
  provider: 'public-cloud',
  role: 'control-plane',
  count: 1,
  ingress: true,
  subnet: 1,
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
  subnet: 3,
  logicalNamePrefix: 'OvhDedicatedControlPlaneServer',
  hostnamePrefix: 'dedicated-control-plane-server',
  plan: '24rise01',
  operatingSystem: 'ubuntu2404-server_64',
  datacenter: 'bhs',
  orderRegion: 'canada',
  planOptions: []
} satisfies NodePool;

void test('owns the private network allocation in one value', () => {
  assert.deepEqual(CLUSTER_NETWORK, {
    cidr: '10.0.0.0/16',
    dhcpStart: '10.0.0.2',
    dhcpEnd: '10.0.0.254',
    metalLb: '10.0.5.1-10.0.5.254'
  });
});

void test('builds stable identities and role-owned addresses for mixed providers', () => {
  const result = buildClusterPlan(
    [
      cloudControlPlane,
      {
        ...cloudControlPlane,
        name: 'cloud-workers',
        role: 'worker',
        subnet: 2,
        logicalNamePrefix: 'OvhWorkerServer',
        hostnamePrefix: 'worker-server'
      },
      dedicatedControlPlane,
      {
        ...dedicatedControlPlane,
        name: 'dedicated-workers',
        role: 'worker',
        count: 1,
        subnet: 4,
        logicalNamePrefix: 'OvhDedicatedWorkerServer',
        hostnamePrefix: 'dedicated-worker-server'
      }
    ],
    'prod'
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
  const result = buildClusterPlan([{ ...dedicatedControlPlane, count: 1 }], 'prod');
  assert.equal(result.nodes[0]?.bootstrapCandidate, true);
});

void test('resource identity is independent of pool ordering', () => {
  const first = buildClusterPlan([cloudControlPlane, dedicatedControlPlane], 'prod');
  const second = buildClusterPlan([dedicatedControlPlane, cloudControlPlane], 'prod');
  assert.deepEqual(
    new Set(first.nodes.map((node) => node.logicalName)),
    new Set(second.nodes.map((node) => node.logicalName))
  );
});

void test('rejects invalid cluster shapes', () => {
  assert.throws(
    () =>
      buildClusterPlan([{ ...cloudControlPlane, name: 'cloud-workers', role: 'worker' }], 'prod'),
    /at least one control-plane node/
  );
  assert.throws(
    () => buildClusterPlan([cloudControlPlane, cloudControlPlane], 'prod'),
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
            count: 255,
            subnet: 4
          }
        ],
        'prod'
      ),
    /dedicated-workers.*10\.0\.4\.1-10\.0\.4\.254/
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
            count: 1,
            subnet: 1
          }
        ],
        'prod'
      ),
    /Duplicate node pool subnet/
  );
  assert.throws(
    () => buildClusterPlan([{ ...cloudControlPlane, subnet: 5 }], 'prod'),
    /reserved for MetalLB/
  );
});

void test('accepts every address available to the configured node pools', () => {
  const result = buildClusterPlan(
    [
      { ...cloudControlPlane, count: 254 },
      {
        ...cloudControlPlane,
        name: 'cloud-workers',
        role: 'worker',
        count: 254,
        subnet: 2
      },
      { ...dedicatedControlPlane, count: 254 },
      {
        ...dedicatedControlPlane,
        name: 'dedicated-workers',
        role: 'worker',
        count: 254,
        subnet: 4
      }
    ],
    'prod'
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
    'prod'
  );
  assert.equal(result.nodes.length, 26);
});

void test('validates dedicated catalog settings and embedded-etcd HA', () => {
  assert.throws(
    () => buildClusterPlan([{ ...dedicatedControlPlane, plan: '' }], 'prod'),
    /requires plan/
  );
  assert.match(
    buildClusterPlan([cloudControlPlane], 'prod').warnings[0] ?? '',
    /odd control-plane count of at least 3/
  );
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
