import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLUSTER_NETWORK_INDEXES,
  type ClusterConfig,
  type ClusterRegion,
  type ClusterSpec,
  type DedicatedServer,
  type NodePoolConfig,
  type PublicCloudServer,
  type PublicIngressConfig
} from '../cluster/config.ts';
import {
  buildClusterPlan,
  buildClusterTopology,
  clusterTokenSecretName,
  getGlobalPublicIngressMode,
  getPoolScaleDownTarget
} from '../cluster/topology.ts';

const publicCloudServer: PublicCloudServer = {
  type: 'public-cloud',
  region: 'US-WEST-OR-1',
  flavor: 'b3-8',
  image: 'Ubuntu 26.04'
};

const dedicatedServer: DedicatedServer = {
  type: 'dedicated',
  datacenter: 'vin',
  planCode: '24rise01',
  operatingSystem: 'ubuntu2604-server_64',
  orderRegion: 'usa',
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
    region: args.region ?? 'us-west',
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

const publicCloudIngress: PublicIngressConfig = { type: 'public-cloud', flavor: 'small' };
const interconnect = { vlanId: 4000, cidr: '172.16.0.0/12' };

function config(
  clusters: ClusterSpec[],
  publicIngress: PublicIngressConfig = publicCloudIngress
): ClusterConfig {
  return { clusters, interconnect, publicIngress };
}

void test('permanently maps every cluster region to its network index', () => {
  assert.deepEqual(CLUSTER_NETWORK_INDEXES, {
    'us-west': 0,
    'us-east': 1,
    europe: 2,
    asia: 3
  });
});

void test('derives every address and identity from the cluster region alone', () => {
  const plan = buildClusterPlan(cluster({ controlPlanes: 1, workers: 1 }), 'prod', 'pandoks.com');

  assert.deepEqual(plan.network, {
    publicCloudRegion: 'US-WEST-OR-1',
    vlanId: 0,
    networkCidr: '10.0.0.0/16',
    gatewayIp: '10.0.0.1',
    allocationPool: { start: '10.0.0.2', end: '10.0.0.254' },
    podCidr: '10.42.0.0/16',
    serviceCidr: '10.43.0.0/16',
    metalLbRange: '10.0.200.1-10.0.200.254'
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
        logicalName: 'OvhUsWestControlPlaneServer0',
        hostname: 'prod-us-west-ovh-control-plane-server-0',
        privateIp: '10.0.1.1',
        bootstrapCandidate: true
      },
      {
        logicalName: 'OvhUsWestWorkersServer0',
        hostname: 'prod-us-west-ovh-workers-server-0',
        privateIp: '10.0.2.1',
        bootstrapCandidate: false
      }
    ]
  );
  assert.deepEqual(plan.identity, {
    resourcePrefix: 'UsWest',
    namePrefix: 'prod-us-west',
    apiHostname: 'k3s-api.us-west.pandoks.com',
    operatorHostname: 'prod-us-west-cluster',
    tokenSecretName: 'OvhUsWestK3sToken',
    etcdBackupFolder: 'kubernetes/etcd/us-west'
  });
  assert.equal(clusterTokenSecretName('us-west'), 'OvhUsWestK3sToken');
});

void test('keeps every mapped region address space independent', () => {
  const plan = buildClusterPlan(
    cluster({ region: 'asia', controlPlanes: 1 }),
    'prod',
    'pandoks.com'
  );
  assert.equal(plan.network.vlanId, 3);
  assert.equal(plan.network.networkCidr, '10.3.0.0/16');
  assert.equal(plan.network.podCidr, '10.48.0.0/16');
  assert.equal(plan.network.serviceCidr, '10.49.0.0/16');
  assert.equal(plan.network.metalLbRange, '10.3.200.1-10.3.200.254');
  assert.equal(plan.nodes[0]?.privateIp, '10.3.1.1');
  assert.equal(plan.identity.operatorHostname, 'prod-asia-cluster');
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
    { ...cluster(), network: { vlanId: 7, metalLbRange: '10.0.5.1-10.0.5.254' } },
    'prod',
    'pandoks.com'
  );
  assert.equal(plan.network.vlanId, 7);
  assert.equal(plan.network.metalLbRange, '10.0.5.1-10.0.5.254');
  assert.equal(plan.network.networkCidr, '10.0.0.0/16');

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

void test('requires a public cloud region and keeps pool regions consistent', () => {
  const dedicatedOnly: ClusterSpec = {
    region: 'europe',
    pools: [{ name: 'control-plane', role: 'control-plane', count: 1, server: dedicatedServer }]
  };
  assert.throws(
    () => buildClusterPlan(dedicatedOnly, 'prod', 'pandoks.com'),
    /requires publicCloudRegion/
  );
  const placed = buildClusterPlan(
    { ...dedicatedOnly, publicCloudRegion: 'US-EAST-VA-1' },
    'prod',
    'pandoks.com'
  );
  assert.equal(placed.network.publicCloudRegion, 'US-EAST-VA-1');

  assert.throws(
    () =>
      buildClusterPlan({ ...cluster(), publicCloudRegion: 'US-EAST-VA-1' }, 'prod', 'pandoks.com'),
    /publicCloudRegion conflicts with its pool region/
  );
});

void test('passes raw labels and taints through and rejects unencodable values', () => {
  const plan = buildClusterPlan(cluster({ databases: 1 }), 'prod', 'pandoks.com');
  const database = plan.nodes.find(({ pool }) => pool.name === 'database');
  assert.deepEqual(database?.pool.labels, { 'pandoks.com/workload': 'database' });
  assert.deepEqual(database?.pool.taints, [
    { key: 'pandoks.com/workload', value: 'database', effect: 'NoSchedule' }
  ]);
  assert.equal(database?.privateIp, '10.0.3.1');

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

void test('assigns interconnect addresses to dedicated pools and rejects public cloud ones', () => {
  const plan = buildClusterPlan(
    cluster({ region: 'us-east', dedicatedDatabases: 2 }),
    'prod',
    'pandoks.com'
  );
  assert.deepEqual(plan.interconnect, { vlanId: 4000, cidr: '172.16.0.0/12', prefixLength: 12 });
  assert.deepEqual(
    plan.nodes
      .filter(({ pool }) => pool.interconnect)
      .map(({ hostname, interconnectIp }) => ({ hostname, interconnectIp })),
    [
      { hostname: 'prod-us-east-ovh-dedicated-database-server-0', interconnectIp: '172.17.4.1' },
      { hostname: 'prod-us-east-ovh-dedicated-database-server-1', interconnectIp: '172.17.4.2' }
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
  const east = cluster({ region: 'us-east' });
  const topology = buildClusterTopology(config([west, east]), 'prod', 'pandoks.com');
  assert.deepEqual(
    topology.clusters.map(({ config: spec, nodes }) => [spec.region, nodes[0]?.privateIp]),
    [
      ['us-west', '10.0.1.1'],
      ['us-east', '10.1.1.1']
    ]
  );

  assert.throws(
    () => buildClusterTopology(config([west, west]), 'prod', 'pandoks.com'),
    /Duplicate cluster region: us-west/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west, { ...east, network: { vlanId: 0 } }]),
        'prod',
        'pandoks.com'
      ),
    /Duplicate VLAN 0/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west, { ...east, network: { podCidr: '10.42.0.0/16' } }]),
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
  const plan = buildClusterPlan(
    { ...inert, publicCloudRegion: 'US-WEST-OR-1' },
    'prod',
    'pandoks.com'
  );
  assert.deepEqual(plan.nodes, []);

  assert.throws(
    () =>
      buildClusterPlan(
        {
          ...inert,
          publicCloudRegion: 'US-WEST-OR-1',
          pools: [{ ...inert.pools[0], count: 1 }]
        },
        'prod',
        'pandoks.com'
      ),
    /requires planCode, operatingSystem, and orderRegion/
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
    ...cluster({ region: 'us-east', controlPlanes: 1, workers: 1 }),
    loadBalancerCount: 0
  };
  const publicIngress: PublicIngressConfig = {
    type: 'ip-load-balancing',
    services: [
      {
        serviceName: 'loadbalancer-dedicated-us',
        zones: { 'us-west': 'HIL', 'us-east': 'VIN' }
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
      ['us-west', 'ip-load-balancing', 0],
      ['us-east', 'ip-load-balancing', 0]
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
          { region: 'us-west', zone: 'HIL', natIp: '10.0.254.0/24' },
          { region: 'us-east', zone: 'VIN', natIp: '10.1.254.0/24' }
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
            { serviceName: 'loadbalancer-us', zones: { 'us-west': 'HIL' } },
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
          dedicated([{ serviceName: 'loadbalancer-us', zones: { 'us-west': 'HIL' } }])
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
    logicalName: 'OvhUsWestWorkersServer1',
    hostname: 'prod-us-west-ovh-workers-server-1'
  });
});
