export type ClusterRegionId = 'us-west' | 'us-east' | 'eu' | 'asia';
export type OvhAccountId = 'us' | 'eu';
export type NodePoolName =
  | 'cloud-control-plane'
  | 'cloud-workers'
  | 'cloud-database'
  | 'dedicated-control-plane'
  | 'dedicated-workers'
  | 'dedicated-database';
export type NodeRole = 'control-plane' | 'worker';
export type Workload = 'general' | 'database';

export type DedicatedPlanOption = {
  duration: string;
  planCode: string;
  pricingMode: string;
  quantity: number;
};

export type LoadBalancerFlavor = 'small' | 'medium' | 'large' | 'xl';

export type IpLoadBalancingServiceConfig = {
  account: OvhAccountId;
  serviceName: string;
  zones: Partial<Record<ClusterRegionId, string>>;
};

export type PublicIngressConfig =
  | { type: 'public-cloud'; flavor: LoadBalancerFlavor }
  | { type: 'ip-load-balancing'; services: readonly IpLoadBalancingServiceConfig[] };

type PoolConfig = {
  name: NodePoolName;
  role: NodeRole;
  workload: Workload;
  count: number;
  publicIngress: boolean;
  machineType: string;
};

export type CloudPoolConfig = PoolConfig;
export type DedicatedPoolConfig = PoolConfig & { planOptions: DedicatedPlanOption[] };

export type RegionalClusterConfig = {
  id: ClusterRegionId;
  account: OvhAccountId;
  enabled: boolean;
  publicCloudRegion: string;
  cloudImage: string;
  dedicatedOperatingSystem: string;
  dedicatedDatacenter: string;
  dedicatedCatalogRegion: string;
  vlanId: number;
  networkCidr: string;
  gatewayIp: string;
  allocationPool: { start: string; end: string };
  podCidr: string;
  serviceCidr: string;
  metalLbRange: string;
  cloud: readonly CloudPoolConfig[];
  dedicated: readonly DedicatedPoolConfig[];
  loadBalancerCount: number;
};

export type ClusterConfig = {
  regions: readonly RegionalClusterConfig[];
  publicIngress: PublicIngressConfig;
};

type GatewayModel = 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';
type LoadBalancerAlgorithm = 'leastConnections' | 'roundRobin' | 'sourceIP';

export const GATEWAY_MODEL: GatewayModel = 'S';
export const LOAD_BALANCER_FLAVOR: LoadBalancerFlavor = 'small';
export const LOAD_BALANCER_ALGORITHM: LoadBalancerAlgorithm = 'leastConnections';

export const OVH_ACCOUNTS = {
  us: {
    endpoint: 'ovh-us',
    apiRoot: 'https://api.us.ovhcloud.com/1.0',
    subsidiary: 'US',
    applicationKey: 'edf9a4672d28e3c7',
    applicationSecretEnvironment: 'OVH_APPLICATION_SECRET',
    consumerKeyEnvironment: 'OVH_CONSUMER_KEY'
  },
  eu: {
    endpoint: 'ovh-eu',
    apiRoot: 'https://eu.api.ovh.com/1.0',
    subsidiary: '',
    applicationKeyEnvironment: 'OVH_EU_APPLICATION_KEY',
    applicationSecretEnvironment: 'OVH_EU_APPLICATION_SECRET',
    consumerKeyEnvironment: 'OVH_EU_CONSUMER_KEY'
  }
} as const;

function pools() {
  return {
    cloud: [
      {
        name: 'cloud-control-plane',
        role: 'control-plane',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: 'b3-8'
      },
      {
        name: 'cloud-workers',
        role: 'worker',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: 'b3-8'
      },
      {
        name: 'cloud-database',
        role: 'worker',
        workload: 'database',
        count: 0,
        publicIngress: false,
        machineType: 'b3-8'
      }
    ] satisfies CloudPoolConfig[],
    dedicated: [
      {
        name: 'dedicated-control-plane',
        role: 'control-plane',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: '',
        planOptions: []
      },
      {
        name: 'dedicated-workers',
        role: 'worker',
        workload: 'general',
        count: 0,
        publicIngress: true,
        machineType: '',
        planOptions: []
      },
      {
        name: 'dedicated-database',
        role: 'worker',
        workload: 'database',
        count: 0,
        publicIngress: false,
        machineType: '',
        planOptions: []
      }
    ] satisfies DedicatedPoolConfig[]
  };
}

function regions(): RegionalClusterConfig[] {
  const shared = {
    enabled: false,
    cloudImage: 'Ubuntu 26.04',
    dedicatedOperatingSystem: 'ubuntu2604-server_64',
    dedicatedDatacenter: '',
    dedicatedCatalogRegion: '',
    loadBalancerCount: 0
  } as const;
  return [
    {
      ...shared,
      ...pools(),
      id: 'us-west',
      account: 'us',
      publicCloudRegion: 'US-WEST-OR-1',
      vlanId: 0,
      networkCidr: '10.0.0.0/16',
      gatewayIp: '10.0.0.1',
      allocationPool: { start: '10.0.0.2', end: '10.0.0.254' },
      podCidr: '10.42.0.0/16',
      serviceCidr: '10.43.0.0/16',
      metalLbRange: '10.0.5.1-10.0.5.254'
    },
    {
      ...shared,
      ...pools(),
      id: 'us-east',
      account: 'us',
      publicCloudRegion: 'US-EAST-VA-1',
      vlanId: 101,
      networkCidr: '10.1.0.0/16',
      gatewayIp: '10.1.0.1',
      allocationPool: { start: '10.1.0.2', end: '10.1.0.254' },
      podCidr: '10.44.0.0/16',
      serviceCidr: '10.45.0.0/16',
      metalLbRange: '10.1.5.1-10.1.5.254'
    },
    {
      ...shared,
      ...pools(),
      id: 'eu',
      account: 'eu',
      publicCloudRegion: '',
      vlanId: 102,
      networkCidr: '10.2.0.0/16',
      gatewayIp: '10.2.0.1',
      allocationPool: { start: '10.2.0.2', end: '10.2.0.254' },
      podCidr: '10.46.0.0/16',
      serviceCidr: '10.47.0.0/16',
      metalLbRange: '10.2.5.1-10.2.5.254'
    },
    {
      ...shared,
      ...pools(),
      id: 'asia',
      account: 'eu',
      publicCloudRegion: '',
      vlanId: 103,
      networkCidr: '10.3.0.0/16',
      gatewayIp: '10.3.0.1',
      allocationPool: { start: '10.3.0.2', end: '10.3.0.254' },
      podCidr: '10.48.0.0/16',
      serviceCidr: '10.49.0.0/16',
      metalLbRange: '10.3.5.1-10.3.5.254'
    }
  ];
}

function clusterConfig(): ClusterConfig {
  return {
    regions: regions(),
    publicIngress: { type: 'public-cloud', flavor: LOAD_BALANCER_FLAVOR }
  };
}

export const PRODUCTION_CLUSTER_CONFIG = clusterConfig();
export const NON_PRODUCTION_CLUSTER_CONFIG = clusterConfig();

export const CLUSTER_CONFIGS = {
  production: PRODUCTION_CLUSTER_CONFIG,
  nonProduction: NON_PRODUCTION_CLUSTER_CONFIG
} as const;
