import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClusterConfig,
  ClusterRegion,
  ClusterSpec,
  DedicatedServer,
  NodePoolConfig,
  PublicCloudServer,
  PublicIngressConfig
} from '../cluster/config.ts';
import {
  CLUSTER_NETWORK_INDEXES,
  buildClusterPlan,
  buildClusterTopology,
  clusterTokenSecretName,
  getGlobalPublicIngressMode,
  getPoolScaleDownTarget
} from '../cluster/topology.ts';

const publicCloudServer: PublicCloudServer = {
  type: 'public-cloud',
  flavor: 'b3-8',
  image: 'Ubuntu 26.04'
};

const dedicatedServer: DedicatedServer = {
  type: 'dedicated',
  planCode: '24rise01',
  operatingSystem: 'ubuntu2604-server_64',
  planOptions: []
};

function cluster(
  args: {
    region?: ClusterRegion;
    controlPlanes?: number;
    workers?: number;
    databases?: number;
    dedicatedDatabases?: number;
    loadBalancers?: number;
    pools?: NodePoolConfig[];
  } = {}
): ClusterSpec {
  const ingressNodes = (args.controlPlanes ?? 1) + (args.workers ?? 0);
  return {
    region: args.region ?? 'hil',
    pools: args.pools ?? [
      {
        name: 'control-plane',
        role: 'control-plane',
        count: args.controlPlanes ?? 1,
        publicIngress: true,
        server: publicCloudServer
      },
      {
        name: 'workers',
        role: 'worker',
        count: args.workers ?? 0,
        publicIngress: true,
        server: publicCloudServer
      },
      {
        name: 'database',
        role: 'worker',
        count: args.databases ?? 0,
        labels: { 'pandoks.com/workload': 'database' },
        taints: [{ key: 'pandoks.com/workload', value: 'database', effect: 'NoSchedule' }],
        server: publicCloudServer
      },
      {
        name: 'dedicated-database',
        role: 'worker',
        count: args.dedicatedDatabases ?? 0,
        labels: { 'pandoks.com/workload': 'database' },
        taints: [{ key: 'pandoks.com/workload', value: 'database', effect: 'NoSchedule' }],
        interconnect: true,
        server: dedicatedServer
      }
    ],
    loadBalancerCount: args.loadBalancers ?? (ingressNodes > 1 ? 1 : 0)
  };
}

function config(clusters: ClusterSpec[], publicIngress?: PublicIngressConfig): ClusterConfig {
  return { clusters, publicIngress };
}

void test('permanently allocates a network index to every OVH datacenter', () => {
  assert.deepEqual(CLUSTER_NETWORK_INDEXES, {
    vin: 0,
    hil: 1,
    bhs: 2,
    tor: 3,
    gra: 4,
    rbx: 5,
    sbg: 6,
    par: 7,
    fra: 8,
    lon: 9,
    waw: 10,
    mil: 11,
    sgp: 12,
    syd: 13,
    ynm: 14
  });
});

void test('derives every address and identity from the cluster region alone', () => {
  const plan = buildClusterPlan(cluster({ controlPlanes: 1, workers: 1 }), 'prod', 'pandoks.com');

  assert.deepEqual(plan.network, {
    publicCloudRegion: 'US-WEST-OR-1',
    vlanId: 1,
    networkCidr: '10.1.0.0/16',
    gatewayIp: '10.1.0.1',
    allocationPool: { start: '10.1.0.2', end: '10.1.0.254' },
    podCidr: '10.44.0.0/16',
    serviceCidr: '10.45.0.0/16',
    metalLbRange: '10.1.200.1-10.1.200.254'
  });
  assert.deepEqual(
    plan.nodes.map(({ logicalName, hostname, privateIp, bootstrapCandidate }) => ({
      logicalName,
      hostname,
      privateIp,
      bootstrapCandidate
    })),
    [
      {
        logicalName: 'OvhHilControlPlaneServer0',
        hostname: 'prod-hil-ovh-control-plane-server-0',
        privateIp: '10.1.1.1',
        bootstrapCandidate: true
      },
      {
        logicalName: 'OvhHilWorkersServer0',
        hostname: 'prod-hil-ovh-workers-server-0',
        privateIp: '10.1.2.1',
        bootstrapCandidate: false
      }
    ]
  );
  assert.deepEqual(plan.identity, {
    resourcePrefix: 'Hil',
    namePrefix: 'prod-hil',
    apiHostname: 'k3s-api.hil.pandoks.com',
    operatorHostname: 'prod-hil-cluster',
    tokenSecretName: 'OvhHilK3sToken',
    etcdBackupFolder: 'kubernetes/etcd/hil'
  });
  assert.equal(clusterTokenSecretName('hil'), 'OvhHilK3sToken');
});

void test('keeps every region address space independent', () => {
  const plan = buildClusterPlan(
    cluster({ region: 'vin', controlPlanes: 1 }),
    'prod',
    'pandoks.com'
  );
  assert.equal(plan.network.publicCloudRegion, 'US-EAST-VA-1');
  assert.equal(plan.network.vlanId, 0);
  assert.equal(plan.network.networkCidr, '10.0.0.0/16');
  assert.equal(plan.network.podCidr, '10.42.0.0/16');
  assert.equal(plan.network.serviceCidr, '10.43.0.0/16');
  assert.equal(plan.network.metalLbRange, '10.0.200.1-10.0.200.254');
  assert.equal(plan.nodes[0]?.privateIp, '10.0.1.1');
  assert.equal(plan.identity.operatorHostname, 'prod-vin-cluster');
});

void test('rejects unmapped regions and invalid pool names', () => {
  assert.throws(
    () =>
      buildClusterPlan({ ...cluster(), region: 'moon' as ClusterRegion }, 'prod', 'pandoks.com'),
    /Unknown cluster region: moon/
  );
  const invalid = cluster({
    pools: [{ name: 'Bad_Name', role: 'control-plane', count: 1, server: publicCloudServer }]
  });
  assert.throws(
    () => buildClusterPlan(invalid, 'prod', 'pandoks.com'),
    /must be lowercase kebab-case/
  );
});

void test('honors explicit network overrides while validating their shapes', () => {
  const plan = buildClusterPlan(
    { ...cluster(), network: { vlanId: 7, metalLbRange: '10.1.5.1-10.1.5.254' } },
    'prod',
    'pandoks.com'
  );
  assert.equal(plan.network.vlanId, 7);
  assert.equal(plan.network.metalLbRange, '10.1.5.1-10.1.5.254');
  assert.equal(plan.network.networkCidr, '10.1.0.0/16');

  assert.throws(
    () =>
      buildClusterPlan(
        { ...cluster(), network: { podCidr: '192.168.0.0/24' } },
        'prod',
        'pandoks.com'
      ),
    /podCidr must be a 10\.x\.0\.0\/16/
  );
});

void test('places dedicated-only regions and rejects public cloud pools outside hil/vin', () => {
  const dedicatedOnly = (region: ClusterRegion): ClusterSpec => ({
    region,
    pools: [{ name: 'control-plane', role: 'control-plane', count: 1, server: dedicatedServer }]
  });
  assert.equal(
    buildClusterPlan(dedicatedOnly('gra'), 'prod', 'pandoks.com').network.publicCloudRegion,
    'US-EAST-VA-1'
  );
  assert.equal(
    buildClusterPlan(dedicatedOnly('sgp'), 'prod', 'pandoks.com').network.publicCloudRegion,
    'US-WEST-OR-1'
  );

  assert.throws(
    () => buildClusterPlan(cluster({ region: 'gra' }), 'prod', 'pandoks.com'),
    /cannot host public cloud pools/
  );
});

void test('passes raw labels and taints through and rejects unencodable values', () => {
  const plan = buildClusterPlan(cluster({ databases: 1 }), 'prod', 'pandoks.com');
  const database = plan.nodes.find(({ pool }) => pool.name === 'database');
  assert.deepEqual(database?.pool.labels, { 'pandoks.com/workload': 'database' });
  assert.deepEqual(database?.pool.taints, [
    { key: 'pandoks.com/workload', value: 'database', effect: 'NoSchedule' }
  ]);
  assert.equal(database?.privateIp, '10.1.3.1');

  const invalid = cluster({
    pools: [
      {
        name: 'control-plane',
        role: 'control-plane',
        count: 1,
        labels: { 'pandoks.com/bad': 'a,b' },
        server: publicCloudServer
      }
    ]
  });
  assert.throws(
    () => buildClusterPlan(invalid, 'prod', 'pandoks.com'),
    /cannot contain spaces or commas/
  );
});

void test('derives dedicated placement from the region and assigns interconnect addresses', () => {
  const plan = buildClusterPlan(
    cluster({ region: 'vin', dedicatedDatabases: 2 }),
    'prod',
    'pandoks.com'
  );
  const dedicated = plan.nodePools.find(({ name }) => name === 'dedicated-database');
  assert.equal(dedicated?.provider, 'dedicated');
  if (dedicated?.provider === 'dedicated') {
    assert.equal(dedicated.datacenter, 'vin');
    assert.equal(dedicated.orderRegion, 'usa');
  }
  assert.deepEqual(plan.interconnect, { vlanId: 4000, cidr: '172.16.0.0/12', prefixLength: 12 });
  assert.deepEqual(
    plan.nodes
      .filter(({ pool }) => pool.interconnect)
      .map(({ hostname, interconnectIp }) => ({ hostname, interconnectIp })),
    [
      { hostname: 'prod-vin-ovh-dedicated-database-server-0', interconnectIp: '172.16.4.1' },
      { hostname: 'prod-vin-ovh-dedicated-database-server-1', interconnectIp: '172.16.4.2' }
    ]
  );
  assert.ok(plan.nodes.every(({ pool, interconnectIp }) => pool.interconnect || !interconnectIp));

  const invalid = cluster({
    pools: [
      {
        name: 'control-plane',
        role: 'control-plane',
        count: 1,
        interconnect: true,
        server: publicCloudServer
      }
    ]
  });
  assert.throws(
    () => buildClusterPlan(invalid, 'prod', 'pandoks.com'),
    /Public Cloud instances support a single private NIC/
  );
});

void test('builds independent plans and rejects duplicate or colliding clusters', () => {
  const west = cluster();
  const east = cluster({ region: 'vin' });
  const topology = buildClusterTopology(config([west, east]), 'prod', 'pandoks.com');
  assert.deepEqual(
    topology.clusters.map(({ config: spec, nodes }) => [spec.region, nodes[0]?.privateIp]),
    [
      ['hil', '10.1.1.1'],
      ['vin', '10.0.1.1']
    ]
  );

  assert.throws(
    () => buildClusterTopology(config([west, west]), 'prod', 'pandoks.com'),
    /Duplicate cluster region: hil/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west, { ...east, network: { vlanId: 1 } }]),
        'prod',
        'pandoks.com'
      ),
    /Duplicate VLAN 1/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west, { ...east, network: { podCidr: '10.44.0.0/16' } }]),
        'prod',
        'pandoks.com'
      ),
    /Duplicate pod CIDR/
  );
});

void test('keeps empty stages inert', () => {
  const topology = buildClusterTopology(config([]), 'prod', 'pandoks.com');
  assert.deepEqual(topology.clusters, []);
  assert.deepEqual(topology.ipLoadBalancing, []);
});

void test('requires catalog values only for pools with live nodes', () => {
  const inert = cluster({
    pools: [
      {
        name: 'dedicated-workers',
        role: 'worker',
        count: 0,
        server: { ...dedicatedServer, planCode: '' }
      }
    ]
  });
  const plan = buildClusterPlan(inert, 'prod', 'pandoks.com');
  assert.deepEqual(plan.nodes, []);

  assert.throws(
    () =>
      buildClusterPlan(
        { ...inert, pools: [{ ...inert.pools[0], count: 1 }] },
        'prod',
        'pandoks.com'
      ),
    /requires planCode and operatingSystem/
  );
});

void test('keeps private API and public ingress decisions local to each cluster', () => {
  const direct = buildClusterPlan(cluster(), 'prod', 'pandoks.com');
  assert.equal(direct.privateApi.mode, 'direct');
  assert.equal(direct.publicIngress.mode, 'direct');

  const balanced = buildClusterPlan(
    cluster({ controlPlanes: 3, workers: 1, loadBalancers: 1 }),
    'prod',
    'pandoks.com'
  );
  assert.equal(balanced.privateApi.mode, 'ovh');
  assert.equal(balanced.publicIngress.mode, 'ovh');

  const cloudflare = buildClusterPlan(
    cluster({ controlPlanes: 3, workers: 1, loadBalancers: 2 }),
    'prod',
    'pandoks.com'
  );
  assert.equal(cloudflare.publicIngress.mode, 'cloudflare');
});

void test('plans one Dedicated IP Load Balancing service across clusters by region', () => {
  const west = { ...cluster({ controlPlanes: 1, workers: 1 }), loadBalancerCount: 0 };
  const east = {
    ...cluster({ region: 'vin', controlPlanes: 1, workers: 1 }),
    loadBalancerCount: 0
  };
  const publicIngress: PublicIngressConfig = {
    type: 'ip-load-balancing',
    services: [
      {
        serviceName: 'loadbalancer-dedicated-us',
        zones: { hil: 'HIL', vin: 'VIN' }
      }
    ]
  };

  const topology = buildClusterTopology(config([west, east], publicIngress), 'prod', 'pandoks.com');

  assert.deepEqual(
    topology.clusters.map(({ config: spec, publicIngress: ingress }) => [
      spec.region,
      ingress.mode,
      ingress.loadBalancerCount
    ]),
    [
      ['hil', 'ip-load-balancing', 0],
      ['vin', 'ip-load-balancing', 0]
    ]
  );
  assert.deepEqual(
    topology.ipLoadBalancing.map(({ config: service, clusters }) => ({
      serviceName: service.serviceName,
      clusters: clusters.map(({ cluster: plan, zone, natIp }) => ({
        region: plan.config.region,
        zone,
        natIp
      }))
    })),
    [
      {
        serviceName: 'loadbalancer-dedicated-us',
        clusters: [
          { region: 'hil', zone: 'HIL', natIp: '10.1.254.0/24' },
          { region: 'vin', zone: 'VIN', natIp: '10.0.254.0/24' }
        ]
      }
    ]
  );
});

void test('rejects incomplete Dedicated IP Load Balancing configuration', () => {
  const west = { ...cluster({ controlPlanes: 1, workers: 1 }), loadBalancerCount: 0 };
  const dedicated = (
    services: Extract<PublicIngressConfig, { type: 'ip-load-balancing' }>['services']
  ) => ({ type: 'ip-load-balancing', services }) as const;

  assert.throws(
    () => buildClusterTopology(config([west], dedicated([])), 'prod', 'pandoks.com'),
    /requires exactly one IP Load Balancing zone/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west], dedicated([{ serviceName: ' ', zones: {} }])),
        'prod',
        'pandoks.com'
      ),
    /require serviceName/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config(
          [west],
          dedicated([
            { serviceName: 'loadbalancer-us', zones: { hil: 'HIL' } },
            { serviceName: 'loadbalancer-us', zones: {} }
          ])
        ),
        'prod',
        'pandoks.com'
      ),
    /Duplicate IP Load Balancing service: loadbalancer-us/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west], dedicated([{ serviceName: 'loadbalancer-us', zones: { moon: 'HIL' } }])),
        'prod',
        'pandoks.com'
      ),
    /references unknown cluster moon/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config(
          [{ ...west, loadBalancerCount: 1 }],
          dedicated([{ serviceName: 'loadbalancer-us', zones: { hil: 'HIL' } }])
        ),
        'prod',
        'pandoks.com'
      ),
    /IP Load Balancing requires loadBalancerCount to be 0/
  );
});

void test('chooses global Cloudflare routing from the aggregate origin count', () => {
  assert.equal(getGlobalPublicIngressMode(0), 'none');
  assert.equal(getGlobalPublicIngressMode(1), 'direct');
  assert.equal(getGlobalPublicIngressMode(2), 'cloudflare');
  assert.equal(getGlobalPublicIngressMode(20), 'cloudflare');
});

void test('rejects invalid cluster and load balancer shapes', () => {
  assert.throws(
    () => buildClusterPlan(cluster({ controlPlanes: 0, workers: 1 }), 'prod', 'pandoks.com'),
    /at least one control-plane node/
  );
  assert.throws(
    () => buildClusterPlan(cluster({ loadBalancers: 1 }), 'prod', 'pandoks.com'),
    /one ingress node requires loadBalancerCount to be 0/
  );
  assert.throws(
    () =>
      buildClusterPlan(
        cluster({ controlPlanes: 1, workers: 1, loadBalancers: 0 }),
        'prod',
        'pandoks.com'
      ),
    /multiple ingress nodes require at least one load balancer/
  );
  assert.throws(
    () => buildClusterPlan({ ...cluster(), loadBalancerCount: 1.5 }, 'prod', 'pandoks.com'),
    /loadBalancerCount must be a non-negative integer/
  );
  assert.throws(
    () =>
      buildClusterPlan(
        cluster({ pools: [cluster().pools[0], cluster().pools[0]] }),
        'prod',
        'pandoks.com'
      ),
    /Duplicate node pool name/
  );
});

void test('warns for non-HA embedded etcd and retains scale-down identity', () => {
  const plan = buildClusterPlan(cluster({ workers: 2 }), 'prod', 'pandoks.com');
  assert.match(plan.warnings[0] ?? '', /odd control-plane count of at least 3/);
  assert.deepEqual(getPoolScaleDownTarget(plan, 'workers'), {
    index: 1,
    logicalName: 'OvhHilWorkersServer1',
    hostname: 'prod-hil-ovh-workers-server-1'
  });
});
