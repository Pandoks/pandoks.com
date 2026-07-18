import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeNodePools,
  parseDedicatedPlanOptions,
  parseNodeCount,
  type NodePool
} from './types.ts';

const cloudControlPlane = {
  name: 'cloud-control-plane',
  provider: 'public-cloud',
  role: 'control-plane',
  count: 1,
  ingress: true,
  privateIpStart: 10,
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
  privateIpStart: 30,
  plan: '24rise01',
  operatingSystem: 'ubuntu2404-server_64',
  datacenter: 'bhs',
  orderRegion: 'canada',
  planOptions: []
} satisfies NodePool;

test('normalizes mixed pools with stable legacy Public Cloud identities', () => {
  const result = normalizeNodePools(
    [
      cloudControlPlane,
      {
        ...cloudControlPlane,
        name: 'cloud-workers',
        role: 'worker',
        count: 1,
        privateIpStart: 50
      },
      dedicatedControlPlane
    ],
    'prod',
    '10.0.1.0/24'
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
        privateIp: '10.0.1.10',
        bootstrapCandidate: true
      },
      {
        logicalName: 'OvhWorkerServer0',
        hostname: 'prod-ovh-worker-server-0',
        privateIp: '10.0.1.50',
        bootstrapCandidate: false
      },
      {
        logicalName: 'OvhDedicatedControlPlaneServer0',
        hostname: 'prod-ovh-dedicated-control-plane-server-0',
        privateIp: '10.0.1.30',
        bootstrapCandidate: false
      },
      {
        logicalName: 'OvhDedicatedControlPlaneServer1',
        hostname: 'prod-ovh-dedicated-control-plane-server-1',
        privateIp: '10.0.1.31',
        bootstrapCandidate: false
      }
    ]
  );
  assert.equal(result.warnings.length, 0);
});

test('chooses dedicated as bootstrap candidate when Public Cloud count is zero', () => {
  const result = normalizeNodePools(
    [{ ...dedicatedControlPlane, count: 1 }],
    'prod',
    '10.0.1.0/24'
  );
  assert.equal(result.nodes[0]?.bootstrapCandidate, true);
});

test('resource identity is independent of pool ordering', () => {
  const first = normalizeNodePools(
    [cloudControlPlane, dedicatedControlPlane],
    'prod',
    '10.0.1.0/24'
  );
  const second = normalizeNodePools(
    [dedicatedControlPlane, cloudControlPlane],
    'prod',
    '10.0.1.0/24'
  );
  assert.deepEqual(
    new Set(first.nodes.map((node) => node.logicalName)),
    new Set(second.nodes.map((node) => node.logicalName))
  );
});

test('rejects workers without a control plane', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [{ ...cloudControlPlane, name: 'cloud-workers', role: 'worker' }],
        'prod',
        '10.0.1.0/24'
      ),
    /at least one control-plane node/
  );
});

test('rejects duplicate pool names', () => {
  assert.throws(
    () => normalizeNodePools([cloudControlPlane, cloudControlPlane], 'prod', '10.0.1.0/24'),
    /Duplicate node pool name/
  );
});

test('rejects overlapping address ranges', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [cloudControlPlane, { ...dedicatedControlPlane, count: 2, privateIpStart: 10 }],
        'prod',
        '10.0.1.0/24'
      ),
    /Duplicate private IP/
  );
});

test('rejects an enabled dedicated pool without catalog settings', () => {
  assert.throws(
    () => normalizeNodePools([{ ...dedicatedControlPlane, plan: '' }], 'prod', '10.0.1.0/24'),
    /requires plan/
  );
});

test('warns for a non-HA embedded-etcd control plane', () => {
  const result = normalizeNodePools([cloudControlPlane], 'prod', '10.0.1.0/24');
  assert.match(result.warnings[0] ?? '', /odd control-plane count of at least 3/);
});

test('parses count overrides and dedicated plan options', () => {
  assert.equal(parseNodeCount('', 3), 3);
  assert.equal(parseNodeCount('2', 0), 2);
  assert.throws(() => parseNodeCount('-1', 0), /non-negative integer/);
  assert.deepEqual(parseDedicatedPlanOptions('[]'), []);
  assert.throws(() => parseDedicatedPlanOptions('{"planCode":"x"}'), /must be a JSON array/);
});
