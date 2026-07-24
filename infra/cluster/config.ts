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

/**
 * TYPES
 */
type Catalog<Known extends string> = Known | (string & Record<never, never>);

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
export type DedicatedOrderRegion = Catalog<'usa' | 'canada' | 'europe' | 'apac'>;
export type DedicatedOperatingSystem = Catalog<'ubuntu2604-server_64'>;
export type PublicCloudFlavor = Catalog<
  | 'b3-8' // general purpose
  | 'b3-16'
  | 'b3-32'
  | 'b3-64'
  | 'c3-8' // CPU optimized
  | 'c3-16'
  | 'r3-16' // RAM optimized
  | 'r3-32'
>;
export type PublicCloudImage = Catalog<'Ubuntu 26.04' | 'Ubuntu 24.04' | 'Debian 12'>;
export type PlanDuration = Catalog<'P1M'>;
export type PlanPricingMode = Catalog<'default' | 'upfront12'>;
export type NodeRole = 'control-plane' | 'worker';
export type TaintEffect = 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';

export type NodeTaint = { key: string; value: string; effect: TaintEffect };

export type DedicatedPlanOption = {
  duration: PlanDuration;
  planCode: string;
  pricingMode: PlanPricingMode;
  quantity: number;
};

export type PublicCloudServer = {
  type: 'public-cloud';
  region: PublicCloudRegion;
  flavor: PublicCloudFlavor;
  image: PublicCloudImage;
};

export type DedicatedServer = {
  type: 'dedicated';
  datacenter: DedicatedDatacenter;
  planCode: string; // always from the live cart; no stable vocabulary
  operatingSystem: DedicatedOperatingSystem;
  orderRegion: DedicatedOrderRegion;
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
