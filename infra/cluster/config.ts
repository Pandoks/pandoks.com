// NOTE: the OVH Pulumi provider types every region/datacenter as a plain string, so these
// unions are the typed vocabulary. The US subsidiary only exposes US Public Cloud regions;
// dedicated servers order globally. Validate catalog values against the live authenticated
// cart before setting a non-zero count.
export type PublicCloudRegion = 'US-WEST-OR-1' | 'US-EAST-VA-1';
export type DedicatedDatacenter =
  | 'vin' // Vint Hill, Virginia, USA
  | 'hil' // Hillsboro, Oregon, USA
  | 'bhs' // Beauharnois, Canada
  | 'tor' // Toronto, Canada
  | 'gra' // Gravelines, France
  | 'rbx' // Roubaix, France
  | 'sbg' // Strasbourg, France
  | 'par' // Paris, France
  | 'fra' // Frankfurt, Germany
  | 'lon' // London, United Kingdom
  | 'waw' // Warsaw, Poland
  | 'mil' // Milan, Italy
  | 'sgp' // Singapore
  | 'syd' // Sydney, Australia
  | 'ynm'; // Mumbai, India
export type NodeRole = 'control-plane' | 'worker';
export type TaintEffect = 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';

export type NodeTaint = { key: string; value: string; effect: TaintEffect };

export type DedicatedPlanOption = {
  duration: string;
  planCode: string;
  pricingMode: string;
  quantity: number;
};

export type PublicCloudServer = {
  type: 'public-cloud';
  region: PublicCloudRegion;
  flavor: string;
  image: string;
};

export type DedicatedServer = {
  type: 'dedicated';
  datacenter: DedicatedDatacenter;
  planCode: string;
  operatingSystem: string;
  orderRegion: string;
  planOptions: DedicatedPlanOption[];
};

// WARNING: pool order is address-significant (each pool owns the third octet at its array
// position + 1). Append new pools; never remove or reorder existing ones with live nodes.
export type NodePoolConfig = {
  name: string;
  role: NodeRole;
  count: number;
  labels?: Record<string, string>;
  taints?: NodeTaint[];
  publicIngress?: boolean;
  // NOTE: interconnect requires a dedicated server pool. Public Cloud instances support a
  // single private NIC and Neutron drops foreign VLAN tags, so they cannot join the
  // cross-cluster VLAN.
  interconnect?: boolean;
  server: PublicCloudServer | DedicatedServer;
};

export type DerivedNetwork = {
  publicCloudRegion: PublicCloudRegion;
  vlanId: number;
  networkCidr: string;
  gatewayIp: string;
  allocationPool: { start: string; end: string };
  podCidr: string;
  serviceCidr: string;
  metalLbRange: string;
};

export type ClusterSpec = {
  name: string;
  networkIndex: number;
  pools: NodePoolConfig[];
  publicCloudRegion?: PublicCloudRegion;
  network?: Partial<DerivedNetwork>;
  loadBalancerCount?: number;
};

export type IpLoadBalancingServiceConfig = {
  serviceName: string;
  zones: Record<string, string>;
};

export type PublicIngressConfig =
  | { type: 'public-cloud'; flavor: string }
  | { type: 'ip-load-balancing'; services: readonly IpLoadBalancingServiceConfig[] };

export type InterconnectConfig = {
  vlanId: number;
  cidr: string;
};

export type ClusterConfig = {
  clusters: ClusterSpec[];
  interconnect: InterconnectConfig;
  publicIngress: PublicIngressConfig;
};

type GatewayModel = 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';
type LoadBalancerAlgorithm = 'leastConnections' | 'roundRobin' | 'sourceIP';

export const GATEWAY_MODEL: GatewayModel = 'S';
export const LOAD_BALANCER_FLAVOR = 'small';
export const LOAD_BALANCER_ALGORITHM: LoadBalancerAlgorithm = 'leastConnections';

export const OVH_ACCOUNT = {
  endpoint: 'ovh-us',
  apiRoot: 'https://api.us.ovhcloud.com/1.0',
  subsidiary: 'US',
  applicationKey: 'edf9a4672d28e3c7',
  applicationSecretEnvironment: 'OVH_APPLICATION_SECRET',
  consumerKeyEnvironment: 'OVH_CONSUMER_KEY'
} as const;

function clusterConfig(): ClusterConfig {
  return {
    clusters: [],
    interconnect: { vlanId: 4000, cidr: '172.16.0.0/12' },
    publicIngress: { type: 'public-cloud', flavor: LOAD_BALANCER_FLAVOR }
  };
}

export const PRODUCTION_CLUSTER_CONFIG = clusterConfig();
export const NON_PRODUCTION_CLUSTER_CONFIG = clusterConfig();

export const CLUSTER_CONFIGS = {
  production: PRODUCTION_CLUSTER_CONFIG,
  nonProduction: NON_PRODUCTION_CLUSTER_CONFIG
} as const;
