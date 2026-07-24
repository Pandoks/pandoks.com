import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClusterRegion,
  ClusterSpec,
  DedicatedServer,
  NodePoolConfig,
  PublicCloudServer
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
    pools?: NodePoolConfig[];
  } = {}
): ClusterSpec {
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
    ]
  };
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
        privateIp: '10.1.100.1',
        bootstrapCandidate: true
      },
      {
        logicalName: 'OvhHilWorkersServer0',
        hostname: 'prod-hil-ovh-workers-server-0',
        privateIp: '10.1.103.1',
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
  assert.equal(plan.nodes[0]?.privateIp, '10.0.100.1');
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

void test('derives pool addresses from names, not declaration order', () => {
  const ordered = buildClusterPlan(
    cluster({ controlPlanes: 1, workers: 1, databases: 1 }),
    'prod',
    'pandoks.com'
  );
  const shuffled = buildClusterPlan(
    {
      ...cluster({ controlPlanes: 1, workers: 1, databases: 1 }),
      pools: [...cluster({ controlPlanes: 1, workers: 1, databases: 1 }).pools].reverse()
    },
    'prod',
    'pandoks.com'
  );
  assert.deepEqual(
    new Map(ordered.nodes.map(({ hostname, privateIp }) => [hostname, privateIp])),
    new Map(shuffled.nodes.map(({ hostname, privateIp }) => [hostname, privateIp]))
  );

  // Adding a pool never moves an existing pool's addresses.
  const grown = buildClusterPlan(
    {
      ...cluster({ controlPlanes: 1, workers: 1, databases: 1 }),
      pools: [
        { name: 'analytics', role: 'worker', count: 1, server: publicCloudServer },
        ...cluster({ controlPlanes: 1, workers: 1, databases: 1 }).pools
      ]
    },
    'prod',
    'pandoks.com'
  );
  for (const node of ordered.nodes) {
    assert.equal(
      grown.nodes.find(({ hostname }) => hostname === node.hostname)?.privateIp,
      node.privateIp
    );
  }
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
  assert.equal(database?.privateIp, '10.1.146.1');

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
      { hostname: 'prod-vin-ovh-dedicated-database-server-0', interconnectIp: '172.16.138.1' },
      { hostname: 'prod-vin-ovh-dedicated-database-server-1', interconnectIp: '172.16.138.2' }
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
  const topology = buildClusterTopology([west, east], 'prod', 'pandoks.com');
  assert.deepEqual(
    topology.clusters.map(({ config: spec, nodes }) => [spec.region, nodes[0]?.privateIp]),
    [
      ['hil', '10.1.100.1'],
      ['vin', '10.0.100.1']
    ]
  );

  assert.throws(
    () => buildClusterTopology([west, west], 'prod', 'pandoks.com'),
    /Duplicate cluster region: hil/
  );
});

void test('keeps empty stages inert', () => {
  const topology = buildClusterTopology([], 'prod', 'pandoks.com');
  assert.deepEqual(topology.clusters, []);
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

// privateApi.mode is what cluster.ts obeys: only 'ovh' creates an OVH load balancer.
void test('creates a private API load balancer only for multi-node control planes', () => {
  const empty = buildClusterPlan(cluster({ controlPlanes: 0 }), 'prod', 'pandoks.com');
  assert.equal(empty.privateApi.mode, 'none');
  assert.deepEqual(empty.privateApi.nodes, []);

  const single = buildClusterPlan(cluster({ controlPlanes: 1 }), 'prod', 'pandoks.com');
  assert.equal(single.privateApi.mode, 'direct');
  assert.equal(single.privateApi.nodes.length, 1);

  for (const controlPlanes of [2, 3, 5]) {
    const plan = buildClusterPlan(cluster({ controlPlanes }), 'prod', 'pandoks.com');
    assert.equal(plan.privateApi.mode, 'ovh');
    assert.equal(plan.privateApi.nodes.length, controlPlanes);
  }
});

void test('pools only control-plane nodes behind the private API', () => {
  const plan = buildClusterPlan(
    cluster({ controlPlanes: 3, workers: 2, databases: 1 }),
    'prod',
    'pandoks.com'
  );
  assert.ok(plan.privateApi.nodes.every(({ pool }) => pool.role === 'control-plane'));
  assert.deepEqual(
    plan.privateApi.nodes.map(({ privateIp }) => privateIp),
    ['10.1.100.1', '10.1.100.2', '10.1.100.3']
  );
});

void test('exposes exactly the public-ingress nodes as Cloudflare origins', () => {
  const plan = buildClusterPlan(
    cluster({ controlPlanes: 3, workers: 2, databases: 1, dedicatedDatabases: 1 }),
    'prod',
    'pandoks.com'
  );
  assert.equal(plan.nodes.length, 7);
  assert.deepEqual(
    plan.ingressNodes.map(({ hostname }) => hostname),
    [
      'prod-hil-ovh-control-plane-server-0',
      'prod-hil-ovh-control-plane-server-1',
      'prod-hil-ovh-control-plane-server-2',
      'prod-hil-ovh-workers-server-0',
      'prod-hil-ovh-workers-server-1'
    ]
  );
  assert.ok(plan.ingressNodes.every(({ pool }) => pool.taints.length === 0));

  const none = buildClusterPlan(
    cluster({
      pools: [{ name: 'control-plane', role: 'control-plane', count: 1, server: publicCloudServer }]
    }),
    'prod',
    'pandoks.com'
  );
  assert.deepEqual(none.ingressNodes, []);
});

// getGlobalPublicIngressMode drives infra/cloudflare.ts: 'direct' is a proxied A
// record, 'cloudflare' is the health-checked Cloudflare Load Balancer.
void test('aggregates origins across clusters into one Cloudflare routing decision', () => {
  const originCount = (specs: ClusterSpec[]) =>
    buildClusterTopology(specs, 'prod', 'pandoks.com').clusters.flatMap(
      ({ ingressNodes }) => ingressNodes
    ).length;

  assert.equal(originCount([]), 0);
  assert.equal(getGlobalPublicIngressMode(originCount([])), 'none');

  const oneOrigin = originCount([cluster({ controlPlanes: 1 })]);
  assert.equal(oneOrigin, 1);
  assert.equal(getGlobalPublicIngressMode(oneOrigin), 'direct');

  const acrossClusters = originCount([
    cluster({ controlPlanes: 1 }),
    cluster({ region: 'vin', controlPlanes: 1 })
  ]);
  assert.equal(acrossClusters, 2);
  assert.equal(getGlobalPublicIngressMode(acrossClusters), 'cloudflare');

  const withinCluster = originCount([cluster({ controlPlanes: 3, workers: 2 })]);
  assert.equal(withinCluster, 5);
  assert.equal(getGlobalPublicIngressMode(withinCluster), 'cloudflare');
});

void test('rejects invalid cluster shapes', () => {
  assert.throws(
    () => buildClusterPlan(cluster({ controlPlanes: 0, workers: 1 }), 'prod', 'pandoks.com'),
    /at least one control-plane node/
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

// End-to-end: one realistic mixed config, asserting every value a downstream
// consumer reads (bootstrap env, secrets, the deploy CLI, and both providers).
void test('translates a mixed multi-region config into every consumed value', () => {
  const topology = buildClusterTopology(
    [
      {
        region: 'hil',
        pools: [
          {
            name: 'control-plane',
            role: 'control-plane',
            count: 3,
            publicIngress: true,
            server: { type: 'public-cloud', flavor: 'b3-8', image: 'Ubuntu 26.04' }
          },
          {
            name: 'gpu',
            role: 'worker',
            count: 1,
            labels: { 'pandoks.com/workload': 'gpu' },
            taints: [{ key: 'pandoks.com/workload', value: 'gpu', effect: 'NoSchedule' }],
            server: { type: 'public-cloud', flavor: 'l40s-90', image: 'Ubuntu 26.04' }
          },
          {
            name: 'database',
            role: 'worker',
            count: 1,
            labels: { 'pandoks.com/workload': 'database' },
            taints: [{ key: 'pandoks.com/workload', value: 'database', effect: 'NoSchedule' }],
            interconnect: true,
            server: {
              type: 'dedicated',
              planCode: '24rise01',
              operatingSystem: 'ubuntu2604-server_64',
              planOptions: [
                { duration: 'P1M', planCode: 'ram-64g', pricingMode: 'default', quantity: 1 }
              ]
            }
          }
        ]
      },
      {
        region: 'sgp',
        pools: [
          {
            name: 'control-plane',
            role: 'control-plane',
            count: 1,
            publicIngress: true,
            server: {
              type: 'dedicated',
              planCode: '24rise01',
              operatingSystem: 'ubuntu2604-server_64',
              planOptions: []
            }
          }
        ]
      }
    ],
    'prod',
    'pandoks.com'
  );

  const [hil, sgp] = topology.clusters;

  // infra/cluster/providers/bootstrap.ts reads these per node.
  assert.deepEqual(
    {
      CLUSTER_REGION: hil.config.region,
      CLUSTER_OPERATOR_HOSTNAME: hil.identity.operatorHostname,
      CLUSTER_POD_CIDR: hil.network.podCidr,
      CLUSTER_SERVICE_CIDR: hil.network.serviceCidr,
      ETCD_BACKUP_FOLDER: hil.identity.etcdBackupFolder,
      VRACK_VLAN_ID: String(hil.network.vlanId)
    },
    {
      CLUSTER_REGION: 'hil',
      CLUSTER_OPERATOR_HOSTNAME: 'prod-hil-cluster',
      CLUSTER_POD_CIDR: '10.44.0.0/16',
      CLUSTER_SERVICE_CIDR: '10.45.0.0/16',
      ETCD_BACKUP_FOLDER: 'kubernetes/etcd/hil',
      VRACK_VLAN_ID: '1'
    }
  );

  const gpu = hil.nodes.find(({ pool }) => pool.name === 'gpu')!;
  assert.equal(gpu.hostname, 'prod-hil-ovh-gpu-server-0');
  assert.equal(gpu.privateIp, '10.1.59.1');
  assert.equal(gpu.interconnectIp, undefined);
  assert.equal(
    Object.entries({ ...gpu.pool.labels, 'pandoks.com/public-ingress': String(false) })
      .map(([key, value]) => `${key}=${value}`)
      .join(','),
    'pandoks.com/workload=gpu,pandoks.com/public-ingress=false'
  );
  assert.equal(
    gpu.pool.taints.map(({ key, value, effect }) => `${key}=${value}:${effect}`).join(','),
    'pandoks.com/workload=gpu:NoSchedule'
  );

  // infra/cluster/providers/public-cloud.ts + dedicated.ts read these per pool.
  const gpuPool = hil.nodePools.find(({ name }) => name === 'gpu')!;
  assert.deepEqual(
    gpuPool.provider === 'public-cloud'
      ? {
          provider: gpuPool.provider,
          region: gpuPool.region,
          flavor: gpuPool.flavor,
          image: gpuPool.image
        }
      : {},
    {
      provider: 'public-cloud',
      region: 'US-WEST-OR-1',
      flavor: 'l40s-90',
      image: 'Ubuntu 26.04'
    }
  );
  const databasePool = hil.nodePools.find(({ name }) => name === 'database')!;
  assert.deepEqual(
    databasePool.provider === 'dedicated'
      ? {
          provider: databasePool.provider,
          datacenter: databasePool.datacenter,
          orderRegion: databasePool.orderRegion,
          planCode: databasePool.planCode,
          operatingSystem: databasePool.operatingSystem,
          planOptions: databasePool.planOptions
        }
      : {},
    {
      provider: 'dedicated',
      datacenter: 'hil',
      orderRegion: 'usa',
      planCode: '24rise01',
      operatingSystem: 'ubuntu2604-server_64',
      planOptions: [{ duration: 'P1M', planCode: 'ram-64g', pricingMode: 'default', quantity: 1 }]
    }
  );

  // The interconnect pool joins the cross-cluster VLAN; sgp lands in its own slice.
  const database = hil.nodes.find(({ pool }) => pool.name === 'database')!;
  assert.equal(database.interconnectIp, '172.17.146.1');
  assert.deepEqual(hil.interconnect, { vlanId: 4000, cidr: '172.16.0.0/12', prefixLength: 12 });
  assert.equal(sgp.interconnect, undefined);

  // infra/secrets.ts derives one k3s token secret per declared region.
  assert.deepEqual(
    topology.clusters.map(({ config }) => clusterTokenSecretName(config.region)),
    ['OvhHilK3sToken', 'OvhSgpK3sToken']
  );

  // scripts/cluster/config.ts emits these for the k3s template render.
  assert.deepEqual(
    topology.clusters.map(({ config, identity, network }) => ({
      ClusterMetalLbRange: network.metalLbRange,
      ClusterRegion: config.region,
      ClusterOperatorHostname: identity.operatorHostname
    })),
    [
      {
        ClusterMetalLbRange: '10.1.200.1-10.1.200.254',
        ClusterRegion: 'hil',
        ClusterOperatorHostname: 'prod-hil-cluster'
      },
      {
        ClusterMetalLbRange: '10.12.200.1-10.12.200.254',
        ClusterRegion: 'sgp',
        ClusterOperatorHostname: 'prod-sgp-cluster'
      }
    ]
  );

  // infra/cluster/cluster.ts: HA control plane gets an OVH LB, single one does not;
  // every ingress node becomes a Cloudflare origin.
  assert.equal(hil.privateApi.mode, 'ovh');
  assert.equal(sgp.privateApi.mode, 'direct');
  assert.equal(sgp.network.publicCloudRegion, 'US-WEST-OR-1');
  const origins = topology.clusters.flatMap(({ ingressNodes }) => ingressNodes);
  assert.equal(origins.length, 4);
  assert.equal(getGlobalPublicIngressMode(origins.length), 'cloudflare');
});
