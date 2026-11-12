import { createHash, createHmac, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../tailscale';
import { STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { backupBucket, s3Endpoint } from '../storage';
import { renderCloudInit } from '../utils';
import type { LatitudeLocation, LatitudeServer } from './latitude';
import type { OvhLocation, OvhServer } from './ovh';

const nodeCloudConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');
// NOTE: gateways get their own template, so node-only edits never rebuild them
const gatewayCloudConfig = readFileSync(`${process.cwd()}/infra/vps/gateway-config.yaml`, 'utf8');

export type Provider = 'ovh' | 'latitude';

// NOTE: hostnames, resource names, and worker IPs derive from `name`, so renaming rebuilds nodes
export type NodePool = {
  name: string;
  location: string;
  role: 'control-plane' | 'worker';
  count: number;
  server: OvhServer | LatitudeServer;
  labels?: Record<string, string>;
  taints?: `${string}=${string}:${'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'}`[];
};
export type Cluster = {
  name: string;
  locations: Record<string, OvhLocation | LatitudeLocation>;
  links: { between: [string, string]; via: 'wireguard' | 'interconnect' }[];
  pools: NodePool[];
};

type NetplanRoute = { to: string; via?: string; scope?: 'link' };
export type PrivateInterface = {
  name: string;
  createNetplanDevices: (routes: NetplanRoute[]) => $util.Input<Record<string, unknown>>;
};
export type Machine = {
  clusterName: string;
  locationKey: string;
  role: 'control-plane' | 'worker' | 'gateway';
  ip: string;
  hostname: string;
  resourceName: string;
  createUserData: (privateInterface: PrivateInterface) => $util.Output<string>;
} & (
  | { provider: 'ovh'; server: OvhServer; location: OvhLocation }
  | { provider: 'latitude'; server: LatitudeServer; location: LatitudeLocation }
);

// NOTE: covers every location's 10.N.0.0/16, which nodes reach through their location's gateway
const PRIVATE_IP_RANGE = '10.0.0.0/8';
const K3S_CIDRS = ['10.42.0.0/16', '10.43.0.0/16'];
// NOTE: k3s/base/core/metallb.yaml and overlays/cluster/prom-etcd-config.yaml pin 10.0.1.x
const FIRST_CONTROL_PLANE_CIDR = '10.0.0.0/16';
// NOTE: k3s/README.md maps each location's addresses
const GATEWAY_IP = [1, 1] as const;
const INTERCONNECT_IP = [1, 2] as const;
const CONTROL_PLANE_IP_START = 10;
const MAX_CONTROL_PLANE_NODES = 10;
const WIREGUARD_PORT = 51820;
// NOTE: a rebuilt bootstrap node starts a new cluster, whose proxy needs the old proxy's hostname
const bootstrapProxyHostnames = new Map<string, string>();
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
// NOTE: the device plugin chart schedules onto nvidia.com/gpu.present nodes and tolerates the taint
const GPU_NODE_ARGS = [
  '--node-label=nvidia.com/gpu.present=true',
  '--node-taint=nvidia.com/gpu=present:NoSchedule',
  '--default-runtime=nvidia'
];

function getLocationIp(cidr: string, [thirdOctet, lastOctet]: readonly [number, number]) {
  return `${cidr.split('.').slice(0, 2).join('.')}.${thirdOctet}.${lastOctet}`;
}

// NOTE: FNV-1a, so declaring, reordering, or removing other pools never moves a worker pool's IPs
function getWorkerPoolOctet(name: string) {
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return (hash % 253) + 2;
}

function getResourceName(...names: string[]) {
  return names
    .flatMap((name) => name.split('-'))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

function checkName(kind: string, name: string) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${kind} name ${name} must be lowercase words joined by single hyphens`);
  }
}

// NOTE: Latitude caps hostnames at 32 characters, and prod is the longest stage name
function checkHostname(hostname: string) {
  if (`prod-${hostname}`.length > 32) {
    throw new Error(
      `Hostname prod-${hostname} is over Latitude's 32 characters; shorten its names`
    );
  }
}

// NOTE: derived from the k3s token, so gateways keep their keys across deploys without a new secret
function getWireguardKeys({ k3sToken, locationKey }: { k3sToken: string; locationKey: string }) {
  const privateKey = createHmac('sha256', k3sToken).update(`wireguard ${locationKey}`).digest();
  const publicKey = createPublicKey(
    createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]),
      format: 'der',
      type: 'pkcs8'
    })
  )
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  return { privateKey: privateKey.toString('base64'), publicKey: publicKey.toString('base64') };
}

/** Maps `from to` to the next hop; per-link tie-breaks give each pair one path, for WireGuard */
function getNextHops({
  locationNames,
  links
}: {
  locationNames: string[];
  links: Cluster['links'];
}) {
  const costs = new Map<string, number>();
  const nextHops = new Map<string, string>();
  for (const [index, { between }] of links.entries()) {
    for (const [from, to] of [between, [...between].reverse()]) {
      costs.set(`${from} ${to}`, 2 ** links.length + 2 ** index);
      nextHops.set(`${from} ${to}`, to);
    }
  }
  for (const through of locationNames) {
    for (const from of locationNames) {
      for (const to of locationNames) {
        const costThrough =
          (costs.get(`${from} ${through}`) ?? Infinity) +
          (costs.get(`${through} ${to}`) ?? Infinity);
        if (from !== to && costThrough < (costs.get(`${from} ${to}`) ?? Infinity)) {
          costs.set(`${from} ${to}`, costThrough);
          nextHops.set(`${from} ${to}`, nextHops.get(`${from} ${through}`)!);
        }
      }
    }
  }
  return nextHops;
}

/** The key's description hashes the user data, so new user data swaps in a fresh one-time key */
function createUserData({
  template,
  resourceName,
  description,
  tags,
  netplanDevices,
  environment
}: {
  template: string;
  resourceName: string;
  description: string;
  tags: string[];
  netplanDevices: $util.Input<Record<string, unknown>>;
  environment: Record<string, $util.Input<string>>;
}): $util.Output<string> {
  const privateNetplan = $util
    .output(netplanDevices)
    .apply((devices) =>
      Buffer.from(JSON.stringify({ network: { version: 2, ...devices } })).toString('base64')
    );
  const renderUserData = (registrationTailnetAuthKey: $util.Input<string>) =>
    $util
      .all({
        ...environment,
        STAGE_NAME: secrets.Stage.value,
        PRIVATE_IP_RANGE,
        PRIVATE_NETPLAN: privateNetplan,
        REGISTRATION_TAILNET_AUTH_KEY: registrationTailnetAuthKey
      })
      .apply((variables) => renderCloudInit(template, variables));

  const registrationTailnetAuthKey = new tailscale.TailnetKey(
    `${resourceName}TailnetRegistrationAuthKey`,
    {
      description: renderUserData('').apply(
        (userData) =>
          `${description} ${createHash('sha256').update(userData).digest('hex').slice(0, 8)}`
      ),
      reusable: false,
      expiry: 86400, // 1 day, since bare metal can take hours to deliver
      preauthorized: true,
      tags
    },
    { dependsOn: [tailscaleAcl] }
  );
  return renderUserData(registrationTailnetAuthKey.key);
}

function getGatewayMachine({
  cluster,
  locationName,
  nextHops,
  gatewayPublicIps
}: {
  cluster: Cluster;
  locationName: string;
  nextHops: Map<string, string>;
  gatewayPublicIps: Record<string, $util.Output<string>>;
}): Machine {
  const location = cluster.locations[locationName];
  const locationNames = Object.keys(cluster.locations);
  const locationKey = getResourceName(cluster.name, locationName);
  const resourceName = `${locationKey}Gateway`;
  const hostname = `${STAGE_NAME}-${cluster.name}-${locationName}-gw`;

  const wireguardPeers = new Map<string, string[]>();
  const interconnectRoutes: NetplanRoute[] = [];
  for (const otherLocationName of locationNames.filter((name) => name !== locationName)) {
    const nextHop = nextHops.get(`${locationName} ${otherLocationName}`)!;
    const { cidr } = cluster.locations[otherLocationName];
    const link = cluster.links.find(
      ({ between }) => between.includes(locationName) && between.includes(nextHop)
    )!;
    if (link.via === 'interconnect') {
      interconnectRoutes.push({ to: cidr, via: getLocationIp(location.cidr, INTERCONNECT_IP) });
    } else {
      wireguardPeers.set(nextHop, [...(wireguardPeers.get(nextHop) ?? []), cidr]);
    }
  }

  const createGatewayUserData = (privateInterface: PrivateInterface) => {
    const peers = [...wireguardPeers].map(([peerName, allowedIps]) => {
      const peerKey = getResourceName(cluster.name, peerName);
      // NOTE: the later-declared gateway dials, so the gateway it dials is created first
      const dials = locationNames.indexOf(peerName) < locationNames.indexOf(locationName);
      return $util
        .all([secrets.k3s.Token.value, dials ? gatewayPublicIps[peerKey] : ''])
        .apply(([k3sToken, publicIp]) => ({
          keys: { public: getWireguardKeys({ k3sToken, locationKey: peerKey }).publicKey },
          'allowed-ips': allowedIps,
          ...(dials && { endpoint: `${publicIp}:${WIREGUARD_PORT}`, keepalive: 25 })
        }));
    });
    return createUserData({
      template: gatewayCloudConfig,
      resourceName,
      description: `${cluster.name} ${locationName} gateway reg`,
      tags: [`tag:${location.provider}`, `tag:${STAGE_NAME}`],
      netplanDevices: $util
        .all([
          privateInterface.createNetplanDevices(interconnectRoutes),
          secrets.k3s.Token.value,
          $util.all(peers)
        ])
        .apply(([devices, k3sToken, resolvedPeers]) => ({
          ...devices,
          ...(resolvedPeers.length > 0 && {
            tunnels: {
              wg0: {
                mode: 'wireguard',
                port: WIREGUARD_PORT,
                key: getWireguardKeys({ k3sToken, locationKey }).privateKey,
                peers: resolvedPeers,
                routes: resolvedPeers
                  .flatMap((peer) => peer['allowed-ips'])
                  .map((to) => ({ to, scope: 'link' }))
              }
            }
          })
        })),
      environment: {
        PRIVATE_INTERFACE: privateInterface.name,
        TAILSCALE_HOSTNAME: hostname
      }
    });
  };

  return {
    clusterName: cluster.name,
    locationKey,
    role: 'gateway',
    ip: getLocationIp(location.cidr, GATEWAY_IP),
    hostname,
    resourceName,
    createUserData: createGatewayUserData,
    provider: location.provider,
    server: location.gateway,
    location
  } as Machine;
}

function getNodeMachine({
  cluster,
  pool,
  index,
  serverApi,
  proxyHostname
}: {
  cluster: Cluster;
  pool: NodePool;
  index: number;
  serverApi: string;
  proxyHostname: string;
}): Machine {
  const location = cluster.locations[pool.location];
  const ip =
    pool.role === 'control-plane'
      ? getLocationIp(location.cidr, [1, CONTROL_PLANE_IP_START + index])
      : getLocationIp(location.cidr, [getWorkerPoolOctet(pool.name), index + 1]);
  const resourceName = `${getResourceName(cluster.name, pool.name)}Server${index}`;
  const hostname = `${STAGE_NAME}-${cluster.name}-${pool.name}-${index}`;
  const role = pool.role === 'control-plane' ? (index === 0 ? 'bootstrap' : 'server') : 'worker';
  const nodeArgs = [
    ...Object.entries(pool.labels ?? {}).map(([key, value]) => `--node-label=${key}=${value}`),
    ...(pool.taints ?? []).map((taint) => `--node-taint=${taint}`),
    ...(pool.server.gpu ? GPU_NODE_ARGS : [])
  ].join(' ');

  return {
    clusterName: cluster.name,
    locationKey: getResourceName(cluster.name, pool.location),
    role: pool.role,
    ip,
    hostname,
    resourceName,
    createUserData: (privateInterface) =>
      createUserData({
        template: nodeCloudConfig,
        resourceName,
        description: `${cluster.name} ${pool.name} ${index} node reg`,
        tags: [`tag:${location.provider}`, `tag:${STAGE_NAME}`, `tag:${pool.role}`],
        netplanDevices: privateInterface.createNetplanDevices([
          { to: PRIVATE_IP_RANGE, via: getLocationIp(location.cidr, GATEWAY_IP) }
        ]),
        environment: {
          ROLE: role,
          CLUSTER_NAME: cluster.name,
          K3S_TOKEN: secrets.k3s.Token.value,
          SERVER_API: serverApi,
          NODE_IP: ip,
          PRIVATE_INTERFACE: privateInterface.name,
          K3S_NODE_ARGS: nodeArgs,
          GPU: pool.server.gpu ?? '',
          TAILSCALE_HOSTNAME: hostname,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID: secrets.k8s.tailscale.OauthClientId.value,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET: secrets.k8s.tailscale.OauthClientSecret.value,
          KUBERNETES_TAILSCALE_HOSTNAME: proxyHostname,
          S3_HOST: s3Endpoint,
          BACKUP_BUCKET: backupBucket.name,
          S3_ACCESS_KEY: secrets.cloudflare.BackupAccessKey.value,
          S3_SECRET_KEY: secrets.cloudflare.BackupSecretKey.value
        }
      }),
    provider: location.provider,
    server: pool.server,
    location
  } as Machine;
}

/** Callers set `gatewayPublicIps[locationKey]` to each gateway's public IP for later ones */
export function getMachines({
  clusters,
  gatewayPublicIps
}: {
  clusters: Cluster[];
  gatewayPublicIps: Record<string, $util.Output<string>>;
}): Machine[] {
  const clusterNames = new Set<string>();
  const cidrLocations = new Map<string, string>();
  const resourceNameOwners = new Map<string, string>();
  const checkResourceName = (resourceName: string, owner: string) => {
    const otherOwner = resourceNameOwners.get(resourceName);
    if (otherOwner) {
      throw new Error(`${otherOwner} and ${owner} both make ${resourceName}; rename one`);
    }
    resourceNameOwners.set(resourceName, owner);
  };
  return clusters.flatMap((cluster, clusterIndex) => {
    checkName('Cluster', cluster.name);
    if (clusterNames.has(cluster.name)) {
      throw new Error(`Cluster name ${cluster.name} is used twice`);
    }
    clusterNames.add(cluster.name);

    // Locations and links
    const locationNames = Object.keys(cluster.locations);
    for (const [locationName, location] of Object.entries(cluster.locations)) {
      checkName('Location', locationName);
      checkHostname(`${cluster.name}-${locationName}-gw`);
      checkResourceName(
        `${getResourceName(cluster.name, locationName)}Gateway`,
        `${cluster.name}/${locationName}`
      );
      if (!/^10\.(0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])\.0\.0\/16$/.test(location.cidr)) {
        throw new Error(`Location ${locationName}'s cidr ${location.cidr} must be a 10.N.0.0/16`);
      }
      if (K3S_CIDRS.includes(location.cidr)) {
        throw new Error(
          `Location ${locationName}'s cidr ${location.cidr} is k3s's pod or service range`
        );
      }
      const overlappingLocation = cidrLocations.get(location.cidr);
      if (overlappingLocation) {
        throw new Error(
          `Locations ${overlappingLocation} and ${cluster.name}/${locationName} both use ${location.cidr}`
        );
      }
      cidrLocations.set(location.cidr, `${cluster.name}/${locationName}`);
      if (locationNames.length > 1 && !location.gateway) {
        throw new Error(`Location ${locationName} needs a gateway to reach its cluster's others`);
      }
      if (locationNames.length === 1 && location.gateway) {
        throw new Error(`Location ${locationName} has a gateway but no other location to reach`);
      }
    }
    const linkedPairs = new Set<string>();
    for (const { between } of cluster.links) {
      const missingLocation = between.find((name) => !(name in cluster.locations));
      if (missingLocation) {
        throw new Error(`Link ${between.join('-')} names missing location ${missingLocation}`);
      }
      const pair = [...between].sort().join(' ');
      if (between[0] === between[1] || linkedPairs.has(pair)) {
        throw new Error(`Link ${between.join('-')} must join two locations not already linked`);
      }
      linkedPairs.add(pair);
    }
    const nextHops = getNextHops({ locationNames, links: cluster.links });
    for (const locationName of locationNames.slice(1)) {
      if (!nextHops.has(`${locationNames[0]} ${locationName}`)) {
        throw new Error(`Location ${locationName} has no links to the rest of ${cluster.name}`);
      }
    }

    // Pools
    const controlPlanePools = cluster.pools.filter((pool) => pool.role === 'control-plane');
    const workerPools = cluster.pools.filter((pool) => pool.role === 'worker');
    const controlPlaneCount = controlPlanePools[0]?.count ?? 0;
    if (controlPlanePools.length > 1) {
      throw new Error(
        `Define one control-plane pool in ${cluster.name}, so etcd stays in one location`
      );
    }
    if (controlPlaneCount > MAX_CONTROL_PLANE_NODES) {
      throw new Error(`The control-plane pool can have up to ${MAX_CONTROL_PLANE_NODES} nodes`);
    }
    if (controlPlaneCount === 0 && workerPools.some((pool) => pool.count > 0)) {
      throw new Error('Worker nodes need at least one control-plane node to join');
    }
    const poolNames = new Set<string>();
    const workerPoolOctets = new Map<string, string>();
    for (const pool of cluster.pools) {
      checkName('Pool', pool.name);
      checkHostname(`${cluster.name}-${pool.name}-${Math.max(pool.count - 1, 0)}`);
      if (poolNames.has(pool.name)) {
        throw new Error(`Pool name ${pool.name} is used twice in ${cluster.name}`);
      }
      poolNames.add(pool.name);
      if (!Number.isInteger(pool.count) || pool.count < 0) {
        throw new Error(`Pool ${pool.name}'s count must be a whole number`);
      }
      checkResourceName(
        `${getResourceName(cluster.name, pool.name)}Server`,
        `${cluster.name}/${pool.name}`
      );
      if (!(pool.location in cluster.locations)) {
        throw new Error(`Pool ${pool.name} names missing location ${pool.location}`);
      }
      const { provider, cidr } = cluster.locations[pool.location];
      if (pool.server.provider !== provider) {
        throw new Error(
          `Pool ${pool.name} needs a ${provider} server for location ${pool.location}`
        );
      }
      if (
        clusterIndex === 0 &&
        pool.role === 'control-plane' &&
        cidr !== FIRST_CONTROL_PLANE_CIDR
      ) {
        throw new Error(
          `Pool ${pool.name} must be in ${FIRST_CONTROL_PLANE_CIDR}, which k3s/ pins for the first cluster`
        );
      }
      if (pool.role === 'worker') {
        const octetKey = `${pool.location} ${getWorkerPoolOctet(pool.name)}`;
        const collidingPoolName = workerPoolOctets.get(octetKey);
        if (collidingPoolName) {
          throw new Error(`Pools ${collidingPoolName} and ${pool.name} share IPs; rename one`);
        }
        workerPoolOctets.set(octetKey, pool.name);
        if (pool.count > 254) {
          throw new Error(`Pool ${pool.name} can have up to 254 nodes`);
        }
      }
    }

    // TODO: name each cluster's proxy after it once deploy tooling handles several clusters
    const proxyHostname =
      clusterIndex === 0 ? `${STAGE_NAME}-cluster` : `${STAGE_NAME}-${cluster.name}-cluster`;
    // NOTE: recorded with zero nodes too, so scaling the bootstrap node to zero removes the proxy
    if (controlPlanePools[0]) {
      bootstrapProxyHostnames.set(
        `${STAGE_NAME}-${cluster.name}-${controlPlanePools[0].name}-0`,
        proxyHostname
      );
    }

    // NOTE: a cluster without nodes orders nothing, so it deploys before its providers are set up
    if (controlPlaneCount === 0) return [];
    const controlPlaneCidr = cluster.locations[controlPlanePools[0].location].cidr;
    const serverApi = `https://${getLocationIp(controlPlaneCidr, [1, CONTROL_PLANE_IP_START])}:6443`;
    return [
      ...(locationNames.length > 1 ? locationNames : []).map((locationName) =>
        getGatewayMachine({ cluster, locationName, nextHops, gatewayPublicIps })
      ),
      ...[...controlPlanePools, ...workerPools].flatMap((pool) =>
        Array.from({ length: pool.count }, (_, index) =>
          getNodeMachine({ cluster, pool, index, serverApi, proxyHostname })
        )
      )
    ];
  });
}

async function deleteTailnetDevices({
  hostname,
  tags
}: {
  hostname: string | undefined;
  tags: string[];
}) {
  if (!hostname) return;
  const { devices = [] } = await tailscale.getDevices({ namePrefix: hostname });
  const matchingDevices = devices.filter(
    (device) => device.hostname === hostname && tags.every((tag) => device.tags.includes(tag))
  );
  if (matchingDevices.length > 0) {
    const deletedDevices = deleteTailscaleDevices(
      ...matchingDevices.map((device) => device.nodeId)
    );
    deletedDevices.apply((deletedDevices) => {
      const deletedDeviceIds = deletedDevices
        .filter((device) => device.success)
        .map((device) => device.deviceId);
      const failedToDeleteDeviceIds = deletedDevices
        .filter((device) => !device.success)
        .map((device) => device.deviceId);
      if (deletedDeviceIds.length) {
        console.log(
          `Deleted Tailscale devices:\n${matchingDevices
            .filter((device) => deletedDeviceIds.includes(device.nodeId))
            .map((device) => device.name)
            .join('\n')}`
        );
      }
      if (failedToDeleteDeviceIds.length) {
        console.log(
          `Failed to delete Tailscale devices:\n${matchingDevices
            .filter((device) => failedToDeleteDeviceIds.includes(device.nodeId))
            .map((device) => device.name)
            .join('\n')}`
        );
      }
    });
  }
}

export function createTailnetCleanupHook({
  name,
  provider,
  getTailscaleHostname
}: {
  name: string;
  provider: Provider;
  getTailscaleHostname: (
    serverHookArgs: $util.ResourceHookArgs
  ) => string | undefined | Promise<string | undefined>;
}) {
  return new $util.ResourceHook(name, async (serverHookArgs) => {
    const tailscaleHostname = await getTailscaleHostname(serverHookArgs);
    const proxyHostname = bootstrapProxyHostnames.get(tailscaleHostname ?? '');
    await Promise.all([
      deleteTailnetDevices({
        hostname: tailscaleHostname,
        tags: [`tag:${provider}`, `tag:${STAGE_NAME}`]
      }),
      ...(proxyHostname
        ? [
            deleteTailnetDevices({
              hostname: proxyHostname,
              tags: ['tag:k8s', `tag:${STAGE_NAME}`]
            })
          ]
        : [])
    ]);
  });
}
