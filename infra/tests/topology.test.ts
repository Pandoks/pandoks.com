import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCTION_CLUSTER_CONFIG,
  type ClusterConfig,
  type PublicIngressConfig,
  type RegionalClusterConfig
} from '../cluster/config.ts';
import {
  buildClusterTopology,
  buildRegionalClusterPlan,
  getGlobalPublicIngressMode,
  getPoolScaleDownTarget
} from '../cluster/topology.ts';

function region(
  args: {
    id?: RegionalClusterConfig['id'];
    controlPlanes?: number;
    workers?: number;
    dedicatedControlPlanes?: number;
    dedicatedWorkers?: number;
    databases?: number;
    loadBalancers?: number;
  } = {}
): RegionalClusterConfig {
  const id = args.id ?? 'us-west';
  const base = PRODUCTION_CLUSTER_CONFIG.regions.find((value) => value.id === id)!;
  const ingressNodes =
    (args.controlPlanes ?? 1) +
    (args.workers ?? 0) +
    (args.dedicatedControlPlanes ?? 0) +
    (args.dedicatedWorkers ?? 0);
  return {
    ...base,
    enabled: true,
    publicCloudRegion: base.publicCloudRegion || 'EU-WEST-PAR',
    dedicatedDatacenter: 'bhs',
    dedicatedCatalogRegion: 'canada',
    cloud: base.cloud.map((pool) => ({
      ...pool,
      count:
        pool.name === 'cloud-control-plane'
          ? (args.controlPlanes ?? 1)
          : pool.name === 'cloud-workers'
            ? (args.workers ?? 0)
            : (args.databases ?? 0)
    })),
    dedicated: base.dedicated.map((pool) => ({
      ...pool,
      count:
        pool.name === 'dedicated-control-plane'
          ? (args.dedicatedControlPlanes ?? 0)
          : pool.name === 'dedicated-workers'
            ? (args.dedicatedWorkers ?? 0)
            : 0,
      machineType: '24rise01'
    })),
    loadBalancerCount: args.loadBalancers ?? (ingressNodes > 1 ? 1 : 0)
  };
}

const publicCloudIngress: PublicIngressConfig = { type: 'public-cloud', flavor: 'small' };

function config(
  regions: readonly RegionalClusterConfig[],
  publicIngress: PublicIngressConfig = publicCloudIngress
): ClusterConfig {
  return { regions, publicIngress };
}

void test('preserves every existing US-West identity and address', () => {
  const plan = buildRegionalClusterPlan(
    region({ controlPlanes: 1, workers: 1, dedicatedControlPlanes: 2, dedicatedWorkers: 1 }),
    'prod',
    'pandoks.com'
  );

  assert.deepEqual(
    plan.nodes.map(({ logicalName, hostname, privateIp, bootstrapCandidate }) => ({
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
  assert.deepEqual(plan.identity, {
    resourcePrefix: '',
    namePrefix: 'prod',
    apiHostname: 'k3s-api.pandoks.com',
    operatorHostname: 'prod-cluster',
    tokenSecretName: 'OvhK3sToken',
    etcdBackupFolder: 'kubernetes/etcd'
  });
});

void test('qualifies future regional identities and keeps their address space independent', () => {
  const plan = buildRegionalClusterPlan(
    region({ id: 'us-east', controlPlanes: 1, workers: 1 }),
    'prod',
    'pandoks.com'
  );

  assert.deepEqual(
    plan.nodes.map(({ logicalName, hostname, privateIp }) => ({
      logicalName,
      hostname,
      privateIp
    })),
    [
      {
        logicalName: 'OvhUsEastControlPlaneServer0',
        hostname: 'prod-us-east-ovh-control-plane-server-0',
        privateIp: '10.1.1.1'
      },
      {
        logicalName: 'OvhUsEastWorkerServer0',
        hostname: 'prod-us-east-ovh-worker-server-0',
        privateIp: '10.1.2.1'
      }
    ]
  );
  assert.deepEqual(plan.identity, {
    resourcePrefix: 'UsEast',
    namePrefix: 'prod-us-east',
    apiHostname: 'k3s-api.us-east.pandoks.com',
    operatorHostname: 'prod-us-east-cluster',
    tokenSecretName: 'OvhUsEastK3sToken',
    etcdBackupFolder: 'kubernetes/etcd/us-east'
  });
});

void test('builds independent plans and rejects duplicate regional address identities', () => {
  const west = region();
  const east = region({ id: 'us-east' });
  const topology = buildClusterTopology(config([west, east]), 'prod', 'pandoks.com');
  assert.deepEqual(
    topology.regions.map(({ config, nodes }) => [config.id, nodes[0]?.privateIp]),
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
        config([
          west,
          {
            ...east,
            networkCidr: west.networkCidr,
            gatewayIp: west.gatewayIp,
            allocationPool: west.allocationPool,
            metalLbRange: west.metalLbRange
          }
        ]),
        'prod',
        'pandoks.com'
      ),
    /Duplicate network CIDR/
  );
  assert.throws(
    () =>
      buildClusterTopology(config([west, { ...east, vlanId: west.vlanId }]), 'prod', 'pandoks.com'),
    /Duplicate VLAN 0 for OVH account us/
  );
});

void test('keeps disabled templates inert and rejects hidden compute', () => {
  const disabled = PRODUCTION_CLUSTER_CONFIG.regions[0];
  const topology = buildClusterTopology(PRODUCTION_CLUSTER_CONFIG, 'prod', 'pandoks.com');
  assert.deepEqual(topology.regions, []);

  assert.throws(
    () =>
      buildClusterTopology(
        config([
          {
            ...disabled,
            cloud: disabled.cloud.map((pool, index) => ({
              ...pool,
              count: index === 0 ? 1 : 0
            }))
          }
        ]),
        'prod',
        'pandoks.com'
      ),
    /Disabled cluster region us-west requires every node and load balancer count to be 0/
  );
});

void test('requires provider and dedicated catalog locations only when used', () => {
  assert.throws(
    () =>
      buildRegionalClusterPlan(
        { ...region({ id: 'eu' }), publicCloudRegion: '' },
        'prod',
        'pandoks.com'
      ),
    /Enabled cluster region eu requires publicCloudRegion/
  );
  assert.throws(
    () =>
      buildRegionalClusterPlan(
        { ...region({ dedicatedControlPlanes: 1 }), dedicatedDatacenter: '' },
        'prod',
        'pandoks.com'
      ),
    /dedicatedDatacenter/
  );
});

void test('keeps pool identities stable across ordering and count changes', () => {
  const one = region({ workers: 1 });
  const three = region({ workers: 3 });
  const reordered = { ...three, cloud: [...three.cloud].reverse() };
  const first = buildRegionalClusterPlan(one, 'prod', 'pandoks.com');
  const expanded = buildRegionalClusterPlan(three, 'prod', 'pandoks.com');
  const shuffled = buildRegionalClusterPlan(reordered, 'prod', 'pandoks.com');

  assert.deepEqual(
    first.nodes.map(({ logicalName, privateIp }) => ({ logicalName, privateIp })),
    expanded.nodes.slice(0, 2).map(({ logicalName, privateIp }) => ({ logicalName, privateIp }))
  );
  assert.deepEqual(
    new Map(expanded.nodes.map((node) => [node.logicalName, node.privateIp])),
    new Map(shuffled.nodes.map((node) => [node.logicalName, node.privateIp]))
  );
});

void test('keeps private API and public ingress decisions local to each cluster', () => {
  const direct = buildRegionalClusterPlan(region(), 'prod', 'pandoks.com');
  assert.equal(direct.privateApi.mode, 'direct');
  assert.equal(direct.publicIngress.mode, 'direct');

  const balanced = buildRegionalClusterPlan(
    region({ controlPlanes: 3, workers: 1, loadBalancers: 1 }),
    'prod',
    'pandoks.com'
  );
  assert.equal(balanced.privateApi.mode, 'ovh');
  assert.equal(balanced.publicIngress.mode, 'ovh');

  const cloudflare = buildRegionalClusterPlan(
    region({ controlPlanes: 3, workers: 1, loadBalancers: 2 }),
    'prod',
    'pandoks.com'
  );
  assert.equal(cloudflare.publicIngress.mode, 'cloudflare');
});

void test('plans one Dedicated IP Load Balancing service across its account regions', () => {
  const west = { ...region({ controlPlanes: 1, workers: 1 }), loadBalancerCount: 0 };
  const east = {
    ...region({ id: 'us-east', controlPlanes: 1, workers: 1 }),
    loadBalancerCount: 0
  };
  const publicIngress: PublicIngressConfig = {
    type: 'ip-load-balancing',
    services: [
      {
        account: 'us',
        serviceName: 'loadbalancer-dedicated-us',
        zones: { 'us-west': 'HIL', 'us-east': 'VIN' }
      }
    ]
  };

  const topology = buildClusterTopology(config([west, east], publicIngress), 'prod', 'pandoks.com');

  assert.deepEqual(
    topology.regions.map(({ config: regional, publicIngress: ingress }) => [
      regional.id,
      ingress.mode,
      ingress.loadBalancerCount
    ]),
    [
      ['us-west', 'ip-load-balancing', 0],
      ['us-east', 'ip-load-balancing', 0]
    ]
  );
  assert.deepEqual(
    topology.ipLoadBalancing.map(({ config: service, regions }) => ({
      account: service.account,
      serviceName: service.serviceName,
      regions: regions.map(({ cluster, zone, natIp }) => ({
        id: cluster.config.id,
        zone,
        natIp
      }))
    })),
    [
      {
        account: 'us',
        serviceName: 'loadbalancer-dedicated-us',
        regions: [
          { id: 'us-west', zone: 'HIL', natIp: '10.0.8.0/24' },
          { id: 'us-east', zone: 'VIN', natIp: '10.1.8.0/24' }
        ]
      }
    ]
  );
});

void test('rejects incomplete Dedicated IP Load Balancing configuration', () => {
  const west = { ...region({ controlPlanes: 1, workers: 1 }), loadBalancerCount: 0 };
  const dedicated = (
    services: Extract<PublicIngressConfig, { type: 'ip-load-balancing' }>['services']
  ) => ({ type: 'ip-load-balancing', services }) as const;

  assert.throws(
    () => buildClusterTopology(config([west], dedicated([])), 'prod', 'pandoks.com'),
    /requires an IP Load Balancing service for OVH account us/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west], dedicated([{ account: 'us', serviceName: ' ', zones: {} }])),
        'prod',
        'pandoks.com'
      ),
    /requires serviceName/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config(
          [west],
          dedicated([
            { account: 'us', serviceName: 'loadbalancer-us-1', zones: {} },
            { account: 'us', serviceName: 'loadbalancer-us-2', zones: {} }
          ])
        ),
        'prod',
        'pandoks.com'
      ),
    /Duplicate IP Load Balancing service for OVH account us/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config([west], dedicated([{ account: 'us', serviceName: 'loadbalancer-us', zones: {} }])),
        'prod',
        'pandoks.com'
      ),
    /requires an IP Load Balancing zone for region us-west/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        config(
          [{ ...west, loadBalancerCount: 1 }],
          dedicated([
            {
              account: 'us',
              serviceName: 'loadbalancer-us',
              zones: { 'us-west': 'HIL' }
            }
          ])
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

void test('rejects invalid regional cluster and load balancer shapes', () => {
  assert.throws(
    () => buildRegionalClusterPlan(region({ controlPlanes: 0, workers: 1 }), 'prod', 'pandoks.com'),
    /at least one control-plane node/
  );
  assert.throws(
    () => buildRegionalClusterPlan(region({ loadBalancers: 1 }), 'prod', 'pandoks.com'),
    /one ingress node requires loadBalancerCount to be 0/
  );
  assert.throws(
    () =>
      buildRegionalClusterPlan(
        region({ controlPlanes: 1, workers: 1, loadBalancers: 0 }),
        'prod',
        'pandoks.com'
      ),
    /multiple ingress nodes require at least one load balancer/
  );
  assert.throws(
    () => buildRegionalClusterPlan({ ...region(), loadBalancerCount: 1.5 }, 'prod', 'pandoks.com'),
    /loadBalancerCount must be a non-negative integer/
  );
});

void test('keeps database pools private and assigns their reserved block', () => {
  const plan = buildRegionalClusterPlan(region({ databases: 1 }), 'prod', 'pandoks.com');
  const database = plan.nodes.find(({ pool }) => pool.name === 'cloud-database');
  assert.equal(database?.privateIp, '10.0.6.1');
  assert.equal(database?.pool.workload, 'database');
  assert.equal(database?.pool.publicIngress, false);
});

void test('warns for non-HA embedded etcd and retains scale-down identity', () => {
  const plan = buildRegionalClusterPlan(region({ workers: 2 }), 'prod', 'pandoks.com');
  assert.match(plan.warnings[0] ?? '', /odd control-plane count of at least 3/);
  const workers = plan.nodePools.find(({ name }) => name === 'cloud-workers')!;
  assert.deepEqual(getPoolScaleDownTarget(workers, plan.config, 'prod'), {
    index: 1,
    logicalName: 'OvhWorkerServer1',
    hostname: 'prod-ovh-worker-server-1'
  });
});

void test('validates regional CIDRs, gateway, allocation pool, and MetalLB range', () => {
  const base = region();
  for (const [field, value] of [
    ['networkCidr', '10.0.0.0/24'],
    ['gatewayIp', '10.9.0.1'],
    ['metalLbRange', '10.9.5.1-10.9.5.254']
  ] as const) {
    assert.throws(
      () => buildRegionalClusterPlan({ ...base, [field]: value }, 'prod', 'pandoks.com'),
      new RegExp(field)
    );
  }
});

void test('requires unique pod and service CIDRs across enabled clusters', () => {
  const west = region();
  const east = region({ id: 'us-east' });
  const topologyConfig = (overrides: Partial<RegionalClusterConfig>): ClusterConfig => ({
    regions: [west, { ...east, ...overrides }],
    publicIngress: publicCloudIngress
  });
  assert.throws(
    () => buildClusterTopology(topologyConfig({ podCidr: west.podCidr }), 'prod', 'pandoks.com'),
    /Duplicate pod CIDR/
  );
  assert.throws(
    () =>
      buildClusterTopology(
        topologyConfig({ serviceCidr: west.serviceCidr }),
        'prod',
        'pandoks.com'
      ),
    /Duplicate service CIDR/
  );
});
