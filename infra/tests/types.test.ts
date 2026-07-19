import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLUSTER_ADDRESS_PLAN,
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY,
  CLUSTER_NETWORK_CIDR,
  CLUSTER_NETWORK_INFRASTRUCTURE_CONSUMERS,
  formatClusterIp,
  getClusterInfrastructureAllocationDemand,
  getPoolScaleDownTarget,
  NODE_POOL_IDENTITIES,
  normalizeNodePools,
  type NodePool
} from '../cluster/types.ts';

const cloudControlPlane = {
  name: 'cloud-control-plane',
  provider: 'public-cloud',
  role: 'control-plane',
  count: 1,
  ingress: true,
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
  plan: '24rise01',
  operatingSystem: 'ubuntu2404-server_64',
  datacenter: 'bhs',
  orderRegion: 'canada',
  planOptions: []
} satisfies NodePool;

void test('owns the /16 and every current third-octet allocation in code', () => {
  assert.equal(CLUSTER_NETWORK_CIDR, '10.0.0.0/16');
  assert.deepEqual(CLUSTER_ADDRESS_PLAN, {
    infrastructure: { thirdOctet: 0, start: 2, end: 254 },
    'cloud-control-plane': { thirdOctet: 1, start: 1, end: 254 },
    'cloud-workers': { thirdOctet: 2, start: 1, end: 254 },
    'dedicated-control-plane': { thirdOctet: 3, start: 1, end: 254 },
    'dedicated-workers': { thirdOctet: 4, start: 1, end: 254 },
    metalLb: { thirdOctet: 5, start: 1, end: 254 },
    reserved: { startThirdOctet: 6, endThirdOctet: 255 }
  });
});

void test('formats addresses from the configured /16 without duplicating prefixes', () => {
  assert.equal(formatClusterIp(CLUSTER_NETWORK_CIDR, 0, 2), '10.0.0.2');
  assert.equal(formatClusterIp(CLUSTER_NETWORK_CIDR, 5, 254), '10.0.5.254');
  assert.throws(() => formatClusterIp('10.0.1.0/24', 1, 1), /IPv4 \/16 ending in \.0\.0/);
  assert.throws(() => formatClusterIp(CLUSTER_NETWORK_CIDR, 256, 1), /invalid third octet/);
  assert.throws(() => formatClusterIp(CLUSTER_NETWORK_CIDR, 1, 256), /invalid host octet/);
});

void test('normalizes mixed pools into role-owned third-octet address blocks', () => {
  const result = normalizeNodePools(
    [
      cloudControlPlane,
      {
        ...cloudControlPlane,
        name: 'cloud-workers',
        role: 'worker',
        count: 1
      },
      dedicatedControlPlane,
      {
        ...dedicatedControlPlane,
        name: 'dedicated-workers',
        role: 'worker',
        count: 1
      }
    ],
    'prod',
    CLUSTER_NETWORK_CIDR
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
  assert.equal(result.warnings.length, 0);
});

void test('chooses dedicated as bootstrap candidate when Public Cloud count is zero', () => {
  const result = normalizeNodePools(
    [{ ...dedicatedControlPlane, count: 1 }],
    'prod',
    CLUSTER_NETWORK_CIDR
  );
  assert.equal(result.nodes[0]?.bootstrapCandidate, true);
});

void test('resource identity is independent of pool ordering', () => {
  const first = normalizeNodePools(
    [cloudControlPlane, dedicatedControlPlane],
    'prod',
    CLUSTER_NETWORK_CIDR
  );
  const second = normalizeNodePools(
    [dedicatedControlPlane, cloudControlPlane],
    'prod',
    CLUSTER_NETWORK_CIDR
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
            role: 'worker'
          }
        ],
        'prod',
        CLUSTER_NETWORK_CIDR
      ),
    /at least one control-plane node/
  );
});

void test('rejects duplicate pool names', () => {
  assert.throws(
    () => normalizeNodePools([cloudControlPlane, cloudControlPlane], 'prod', CLUSTER_NETWORK_CIDR),
    /Duplicate node pool name/
  );
});

void test('rejects a count that overflows one third-octet allocation', () => {
  assert.throws(
    () =>
      normalizeNodePools(
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
        CLUSTER_NETWORK_CIDR
      ),
    /dedicated-workers allocation.*10\.0\.4\.1-10\.0\.4\.254/
  );
});

void test('accepts the largest addressable worker pools with 25 total control planes', () => {
  const result = normalizeNodePools(
    [
      { ...cloudControlPlane, count: 12 },
      {
        ...cloudControlPlane,
        name: 'cloud-workers',
        role: 'worker',
        count: 254
      },
      { ...dedicatedControlPlane, count: 13 },
      {
        ...dedicatedControlPlane,
        name: 'dedicated-workers',
        role: 'worker',
        count: 254
      }
    ],
    'prod',
    CLUSTER_NETWORK_CIDR
  );

  assert.equal(CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY, 25);
  assert.equal(result.nodes.length, 533);
  assert.equal(result.nodes.at(-1)?.privateIp, '10.0.4.254');
  assert.equal(getClusterInfrastructureAllocationDemand(result.nodes), 25);
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
        CLUSTER_NETWORK_CIDR
      ),
    /single private API load balancer.*25 control-plane/i
  );
});

void test('rejects a CIDR that is not an aligned IPv4 /16', () => {
  assert.throws(
    () => normalizeNodePools([cloudControlPlane], 'prod', '10.0.1.0/24'),
    /IPv4 \/16 ending in \.0\.0/
  );
  assert.throws(
    () => normalizeNodePools([cloudControlPlane], 'prod', '10.0.1.0/16'),
    /IPv4 \/16 ending in \.0\.0/
  );
});

void test('rejects an enabled dedicated pool without catalog settings', () => {
  assert.throws(
    () =>
      normalizeNodePools([{ ...dedicatedControlPlane, plan: '' }], 'prod', CLUSTER_NETWORK_CIDR),
    /requires plan/
  );
});

void test('warns for a non-HA embedded-etcd control plane', () => {
  const result = normalizeNodePools([cloudControlPlane], 'prod', CLUSTER_NETWORK_CIDR);
  assert.match(result.warnings[0] ?? '', /odd control-plane count of at least 3/);
});

void test('counts only automatically allocated infrastructure addresses', () => {
  const representativeNodes = [
    ...Array.from({ length: 3 }, () => ({
      provider: 'public-cloud' as const,
      role: 'control-plane' as const,
      ingress: true
    })),
    ...Array.from({ length: 4 }, () => ({
      provider: 'public-cloud' as const,
      role: 'worker' as const,
      ingress: true
    })),
    ...Array.from({ length: 2 }, () => ({
      provider: 'dedicated' as const,
      role: 'control-plane' as const,
      ingress: true
    })),
    {
      provider: 'dedicated' as const,
      role: 'worker' as const,
      ingress: true
    }
  ];

  assert.equal(CLUSTER_NETWORK_INFRASTRUCTURE_CONSUMERS, 2);
  assert.equal(getClusterInfrastructureAllocationDemand(representativeNodes), 4);
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
