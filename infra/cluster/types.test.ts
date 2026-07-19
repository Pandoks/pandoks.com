import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY,
  getClusterDhcpAllocationDemand,
  getPoolScaleDownTarget,
  getUnprotectedNodeWarning,
  isClusterNodeProtected,
  NODE_POOL_IDENTITIES,
  normalizeNodePools,
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
  privateIpStart: 150,
  plan: '24rise01',
  operatingSystem: 'ubuntu2404-server_64',
  datacenter: 'bhs',
  orderRegion: 'canada',
  planOptions: []
} satisfies NodePool;

void test('normalizes mixed pools with stable legacy Public Cloud identities', () => {
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
        privateIp: '10.0.1.150',
        bootstrapCandidate: false
      },
      {
        logicalName: 'OvhDedicatedControlPlaneServer1',
        hostname: 'prod-ovh-dedicated-control-plane-server-1',
        privateIp: '10.0.1.151',
        bootstrapCandidate: false
      }
    ]
  );
  assert.equal(result.warnings.length, 0);
});

void test('chooses dedicated as bootstrap candidate when Public Cloud count is zero', () => {
  const result = normalizeNodePools(
    [{ ...dedicatedControlPlane, count: 1 }],
    'prod',
    '10.0.1.0/24'
  );
  assert.equal(result.nodes[0]?.bootstrapCandidate, true);
});

void test('resource identity is independent of pool ordering', () => {
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

void test('rejects workers without a control plane', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [
          {
            ...cloudControlPlane,
            name: 'cloud-workers',
            role: 'worker',
            privateIpStart: 50
          }
        ],
        'prod',
        '10.0.1.0/24'
      ),
    /at least one control-plane node/
  );
});

void test('rejects duplicate pool names', () => {
  assert.throws(
    () => normalizeNodePools([cloudControlPlane, cloudControlPlane], 'prod', '10.0.1.0/24'),
    /Duplicate node pool name/
  );
});

void test('rejects cross-pool address-range drift before IPs can overlap', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [cloudControlPlane, { ...dedicatedControlPlane, count: 2, privateIpStart: 10 }],
        'prod',
        '10.0.1.0/24'
      ),
    /dedicated-control-plane allocation/
  );
});

void test('keeps Public Cloud nodes inside the Neutron-managed DHCP allocation', () => {
  assert.throws(
    () =>
      normalizeNodePools([{ ...cloudControlPlane, privateIpStart: 150 }], 'prod', '10.0.1.0/24'),
    /cloud-control-plane allocation/
  );
});

void test('keeps dedicated nodes outside DHCP and MetalLB allocations', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [{ ...dedicatedControlPlane, count: 1, privateIpStart: 50 }],
        'prod',
        '10.0.1.0/24'
      ),
    /dedicated-control-plane allocation/
  );
  assert.throws(
    () =>
      normalizeNodePools(
        [{ ...dedicatedControlPlane, count: 1, privateIpStart: 100 }],
        'prod',
        '10.0.1.0/24'
      ),
    /MetalLB/
  );
  assert.throws(
    () =>
      normalizeNodePools([{ ...cloudControlPlane, privateIpStart: 100 }], 'prod', '10.0.1.0/24'),
    /MetalLB/
  );
});

void test('rejects pool counts that overflow their reserved address allocation', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [{ ...dedicatedControlPlane, count: 51, privateIpStart: 150 }],
        'prod',
        '10.0.1.0/24'
      ),
    /dedicated-control-plane allocation.*150.*199/
  );
});

void test('accepts the largest mixed topology within API and DHCP aggregate capacity', () => {
  const result = normalizeNodePools(
    [
      { ...cloudControlPlane, count: 12 },
      {
        ...cloudControlPlane,
        name: 'cloud-workers',
        role: 'worker',
        count: 50,
        privateIpStart: 50
      },
      { ...dedicatedControlPlane, count: 13 },
      {
        ...dedicatedControlPlane,
        name: 'dedicated-workers',
        role: 'worker',
        count: 55,
        privateIpStart: 200
      }
    ],
    'prod',
    '10.0.1.0/24'
  );

  assert.equal(CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY, 25);
  assert.equal(result.nodes.length, 130);
  assert.equal(getClusterDhcpAllocationDemand(result.nodes), 71);
});

void test('rejects more control planes than the single private API load balancer can serve', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [
          { ...cloudControlPlane, count: 13 },
          { ...dedicatedControlPlane, count: 13 }
        ],
        'prod',
        '10.0.1.0/24'
      ),
    /single private API load balancer.*25 control-plane/i
  );
});

void test('rejects the former 40/50/50/55 maximum combination', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [
          { ...cloudControlPlane, count: 40 },
          {
            ...cloudControlPlane,
            name: 'cloud-workers',
            role: 'worker',
            count: 50,
            privateIpStart: 50
          },
          { ...dedicatedControlPlane, count: 50 },
          {
            ...dedicatedControlPlane,
            name: 'dedicated-workers',
            role: 'worker',
            count: 55,
            privateIpStart: 200
          }
        ],
        'prod',
        '10.0.1.0/24'
      ),
    /requires 101 Neutron DHCP allocation addresses.*provides 98/i
  );
});

void test('rejects an address range outside the configured IPv4 /24', () => {
  assert.throws(
    () =>
      normalizeNodePools(
        [{ ...dedicatedControlPlane, count: 1, privateIpStart: 255 }],
        'prod',
        '10.0.1.0/24'
      ),
    /outside 10\.0\.1\.0\/24/
  );
});

void test('rejects an enabled dedicated pool without catalog settings', () => {
  assert.throws(
    () => normalizeNodePools([{ ...dedicatedControlPlane, plan: '' }], 'prod', '10.0.1.0/24'),
    /requires plan/
  );
});

void test('warns for a non-HA embedded-etcd control plane', () => {
  const result = normalizeNodePools([cloudControlPlane], 'prod', '10.0.1.0/24');
  assert.match(result.warnings[0] ?? '', /odd control-plane count of at least 3/);
});

void test('defines the exact identity prefixes for all four pools', () => {
  assert.deepEqual(NODE_POOL_IDENTITIES, {
    'cloud-control-plane': {
      logicalNamePrefix: 'OvhControlPlaneServer',
      hostnamePrefix: 'control-plane-server'
    },
    'cloud-workers': {
      logicalNamePrefix: 'OvhWorkerServer',
      hostnamePrefix: 'worker-server'
    },
    'dedicated-control-plane': {
      logicalNamePrefix: 'OvhDedicatedControlPlaneServer',
      hostnamePrefix: 'dedicated-control-plane-server'
    },
    'dedicated-workers': {
      logicalNamePrefix: 'OvhDedicatedWorkerServer',
      hostnamePrefix: 'dedicated-worker-server'
    }
  });
});

void test('scale-down target is always the highest declared pool index', () => {
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

void test('production protection allows only an exact logical-name match', () => {
  const nodes = normalizeNodePools(
    [
      {
        ...cloudControlPlane,
        name: 'cloud-workers',
        role: 'worker',
        count: 3,
        privateIpStart: 50
      },
      cloudControlPlane
    ],
    'prod',
    '10.0.1.0/24'
  ).nodes;
  const lowerIndex = nodes.find((node) => node.logicalName === 'OvhWorkerServer1');
  const highestIndex = nodes.find((node) => node.logicalName === 'OvhWorkerServer2');
  assert.ok(lowerIndex);
  assert.ok(highestIndex);
  assert.equal(isClusterNodeProtected(highestIndex, 'OvhWorkerServer2', true), false);
  assert.equal(isClusterNodeProtected(lowerIndex, 'OvhWorkerServer1', true), true);
  assert.equal(isClusterNodeProtected(highestIndex, '', true), true);
  assert.equal(isClusterNodeProtected(highestIndex, 'OvhWorkerServer2', false), false);
});

void test('warns when the requested unprotected node is absent', () => {
  const nodes = normalizeNodePools(
    [{ ...cloudControlPlane, count: 2 }],
    'prod',
    '10.0.1.0/24'
  ).nodes;
  assert.equal(getUnprotectedNodeWarning(nodes, ''), undefined);
  assert.equal(getUnprotectedNodeWarning(nodes, 'OvhControlPlaneServer1'), undefined);
  assert.match(
    getUnprotectedNodeWarning(nodes, 'OvhControlPlaneServer0') ?? '',
    /does not match a currently declared highest-index node/
  );
  assert.match(
    getUnprotectedNodeWarning(nodes, 'OvhControlPlaneServer2') ?? '',
    /OVH_UNPROTECTED_NODE_LOGICAL_NAME=OvhControlPlaneServer2 does not match a currently declared highest-index node/
  );
});
