export const GATEWAY_MODEL: GatewayModel = 'S';
export const LOAD_BALANCER_FLAVOR = 'small';
export const LOAD_BALANCER_ALGORITHM: LoadBalancerAlgorithm = 'leastConnections';

export const PRODUCTION_CLUSTER_CONFIG: ClusterConfig = {
  clusters: [],
  interconnect: { vlanId: 4000, cidr: '172.16.0.0/12' },
  publicIngress: { type: 'public-cloud', flavor: LOAD_BALANCER_FLAVOR }
};

export const NON_PRODUCTION_CLUSTER_CONFIG: ClusterConfig = {
  clusters: [],
  interconnect: { vlanId: 4000, cidr: '172.16.0.0/12' },
  publicIngress: { type: 'public-cloud', flavor: LOAD_BALANCER_FLAVOR }
};

/**
 * TYPES
 */
export type ClusterConfig = {
  clusters: ClusterSpec[];
  interconnect: InterconnectConfig;
  publicIngress: PublicIngressConfig;
};

export type ClusterSpec = {
  name: string;
  networkIndex: number;
  pools: NodePoolConfig[];
  publicCloudRegion?: PublicCloudRegion;
  network?: Partial<DerivedNetwork>;
  loadBalancerCount?: number;
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

export type DedicatedPlanOption = {
  duration: PlanDuration;
  planCode: string;
  pricingMode: PlanPricingMode;
  quantity: number;
};

export type PublicIngressConfig =
  | { type: 'public-cloud'; flavor: string }
  | { type: 'ip-load-balancing'; services: readonly IpLoadBalancingServiceConfig[] };

export type IpLoadBalancingServiceConfig = {
  serviceName: string;
  zones: Record<string, string>;
};

export type InterconnectConfig = {
  vlanId: number;
  cidr: string;
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

export type NodeTaint = { key: string; value: string; effect: TaintEffect };

export type NodeRole = 'control-plane' | 'worker';
export type TaintEffect = 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
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
export type DedicatedOrderRegion = 'usa' | 'canada' | 'europe' | 'apac';
export type DedicatedOperatingSystem =
  | 'ubuntu2604-server_64' // Ubuntu Server 26.04 LTS
  | 'ubuntu2404-server_64' // Ubuntu Server 24.04 LTS
  | 'ubuntu2204-server_64' // Ubuntu Server 22.04 LTS
  | 'debian12_64' // Debian 12 (Bookworm)
  | 'debian13_64' // Debian 13 (Trixie)
  | 'rocky9_64' // Rocky Linux 9
  | 'alma9_64' // AlmaLinux 9
  | 'byolinux_64'; // Bring Your Own Linux image
export type PublicCloudFlavor =
  // general purpose
  | 'b3-8'
  | 'b3-16'
  | 'b3-32'
  | 'b3-64'
  | 'b3-128'
  | 'b3-256'
  | 'b3-512'
  // CPU optimized
  | 'c3-4'
  | 'c3-8'
  | 'c3-16'
  | 'c3-32'
  | 'c3-64'
  | 'c3-128'
  | 'c3-256'
  // RAM optimized
  | 'r3-16'
  | 'r3-32'
  | 'r3-64'
  | 'r3-128'
  | 'r3-256'
  | 'r3-512';
export type PublicCloudImage = 'Ubuntu 26.04' | 'Ubuntu 24.04' | 'Ubuntu 22.04' | 'Debian 12';
// NOTE: baremetal duration and pricingMode travel as pairs in the cart:
// P1M+default (monthly), P1Y+upfront12 (year upfront), P2Y+upfront24 (2 years upfront)
export type PlanDuration = 'P1M' | 'P1Y' | 'P2Y';
export type PlanPricingMode = 'default' | 'upfront12' | 'upfront24';
type GatewayModel = 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';
type LoadBalancerAlgorithm = 'leastConnections' | 'roundRobin' | 'sourceIP';
