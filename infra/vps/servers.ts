import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../tailscale';
import { STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { backupBucket, s3Endpoint } from '../storage';
import { renderCloudInit } from '../utils';

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');

export type Provider = 'hetzner' | 'ovh' | 'latitude';

/**
 * Identical nodes ordered from one provider. Hostnames, resource names, and worker IPs derive from
 * `name`, so renaming a pool rebuilds its nodes. `server` is the provider's machine type.
 */
export type NodePool<Server> = {
  name: string;
  role: 'control-plane' | 'worker';
  count: number;
  server: Server;
  labels?: Record<string, string>;
  taints?: `${string}=${string}:${'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'}`[];
};
export type ClusterNode<Server> = {
  pool: NodePool<Server>;
  index: number;
  ip: string;
  hostname: string;
  resourceName: string;
};

// NOTE: 10.0.0.x is the provider's (gateway, load balancers, DHCP), 10.0.1.10-19 the control
// plane's, 10.0.1.100-200 MetalLB's, and 10.0.<hash of its name>.x each worker pool's
export const PRIVATE_IP_RANGE = '10.0.0.0/16';
const CONTROL_PLANE_IP_START = 10;
const MAX_CONTROL_PLANE_NODES = 10;
const PROVIDER_RESOURCE_NAMES: Record<Provider, string> = {
  hetzner: 'Hetzner',
  ovh: 'Ovh',
  latitude: 'Latitude'
};
const PROVIDER_KEY_DESCRIPTIONS: Record<Provider, string> = {
  hetzner: 'hcloud',
  ovh: 'ovh',
  latitude: 'latitude'
};

function getPrivateIp(thirdOctet: number, lastOctet: number) {
  return `${PRIVATE_IP_RANGE.split('.').slice(0, 2).join('.')}.${thirdOctet}.${lastOctet}`;
}

// NOTE: FNV-1a, so declaring, reordering, or removing other pools never moves a worker pool's IPs
function getWorkerPoolOctet(name: string) {
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return (hash % 253) + 2;
}

/**
 * Validates the pools and lists their nodes with the control plane first, so the first node
 * bootstraps the cluster.
 */
export function getClusterNodes<Server>({
  provider,
  pools
}: {
  provider: Provider;
  pools: NodePool<Server>[];
}): ClusterNode<Server>[] {
  const controlPlanePools = pools.filter((pool) => pool.role === 'control-plane');
  const workerPools = pools.filter((pool) => pool.role === 'worker');
  const controlPlaneCount = controlPlanePools[0]?.count ?? 0;
  if (controlPlanePools.length > 1) {
    throw new Error('Define one control-plane pool');
  }
  if (controlPlaneCount > MAX_CONTROL_PLANE_NODES) {
    throw new Error(`The control-plane pool can have up to ${MAX_CONTROL_PLANE_NODES} nodes`);
  }
  if (controlPlaneCount === 0 && workerPools.some((pool) => pool.count > 0)) {
    throw new Error('Worker nodes need at least one control-plane node to join');
  }

  const poolNames = new Set<string>();
  const workerPoolOctets = new Map<number, string>();
  for (const pool of pools) {
    // NOTE: hostnames like prod-latitude-<name>-<index> must fit Latitude's 32 characters
    if (!/^[a-z][a-z0-9-]{0,13}$/.test(pool.name)) {
      throw new Error(`Pool name ${pool.name} must be up to 14 lowercase letters, digits, or -`);
    }
    if (poolNames.has(pool.name)) {
      throw new Error(`Pool name ${pool.name} is used twice`);
    }
    poolNames.add(pool.name);
    if (pool.role === 'worker') {
      const octet = getWorkerPoolOctet(pool.name);
      const collidingPoolName = workerPoolOctets.get(octet);
      if (collidingPoolName) {
        throw new Error(`Pools ${collidingPoolName} and ${pool.name} share IPs; rename one`);
      }
      workerPoolOctets.set(octet, pool.name);
      if (pool.count > 254) {
        throw new Error(`Pool ${pool.name} can have up to 254 nodes`);
      }
    }
  }

  return [...controlPlanePools, ...workerPools].flatMap((pool) =>
    Array.from({ length: pool.count }, (_, index) => ({
      pool,
      index,
      ip:
        pool.role === 'control-plane'
          ? getPrivateIp(1, CONTROL_PLANE_IP_START + index)
          : getPrivateIp(getWorkerPoolOctet(pool.name), index + 1),
      hostname: `${STAGE_NAME}-${provider}-${pool.name}-${index}`,
      resourceName: `${getPoolResourceName(pool)}Server${index}`
    }))
  );
}

export function getPoolResourceName({ name }: { name: string }) {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Creates the node's one-time Tailscale key and renders cloud-config.yaml for it. `privateNetplan`
 * is base64 netplan for the private interface, or '' when the provider configures it.
 */
export function createNodeUserData<Server>({
  provider,
  node,
  privateInterface,
  privateNetplan
}: {
  provider: Provider;
  node: ClusterNode<Server>;
  privateInterface: string;
  privateNetplan: $util.Input<string>;
}): $util.Output<string> {
  const { pool, index } = node;
  const role = pool.role === 'control-plane' ? (index === 0 ? 'bootstrap' : 'server') : 'worker';
  const nodeArgs = [
    ...Object.entries(pool.labels ?? {}).map(([key, value]) => `--node-label=${key}=${value}`),
    ...(pool.taints ?? []).map((taint) => `--node-taint=${taint}`)
  ].join(' ');

  const renderUserData = (registrationTailnetAuthKey: $util.Input<string>) =>
    $resolve([
      secrets.Stage.value,
      secrets.hetzner.K3sToken.value,
      privateNetplan,
      registrationTailnetAuthKey,
      secrets.k8s.tailscale.OauthClientId.value,
      secrets.k8s.tailscale.OauthClientSecret.value,
      s3Endpoint,
      backupBucket.name,
      secrets.cloudflare.BackupAccessKey.value,
      secrets.cloudflare.BackupSecretKey.value
    ]).apply(
      ([
        STAGE_NAME,
        K3S_TOKEN,
        PRIVATE_NETPLAN,
        REGISTRATION_TAILNET_AUTH_KEY,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET,
        S3_HOST,
        BACKUP_BUCKET,
        S3_ACCESS_KEY,
        S3_SECRET_KEY
      ]) =>
        renderCloudInit(cloudInitConfig, {
          STAGE_NAME,
          PRIVATE_IP_RANGE,
          K3S_TOKEN,
          SERVER_API: `https://${getPrivateIp(1, CONTROL_PLANE_IP_START)}:6443`,
          NODE_IP: node.ip,
          PRIVATE_INTERFACE: privateInterface,
          PRIVATE_NETPLAN,
          K3S_NODE_ARGS: nodeArgs,
          ROLE: role,
          TAILSCALE_HOSTNAME: node.hostname,
          REGISTRATION_TAILNET_AUTH_KEY,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET,
          KUBERNETES_TAILSCALE_HOSTNAME: `${STAGE_NAME}-cluster`,
          S3_HOST,
          BACKUP_BUCKET,
          S3_ACCESS_KEY,
          S3_SECRET_KEY
        })
    );

  const registrationTailnetAuthKey = new tailscale.TailnetKey(
    `${PROVIDER_RESOURCE_NAMES[provider]}${node.resourceName}TailnetRegistrationAuthKey`,
    {
      // NOTE: the hash swaps in a fresh single-use key whenever new user data rebuilds the node
      description: renderUserData('').apply(
        (userData) =>
          `${PROVIDER_KEY_DESCRIPTIONS[provider]} ${pool.name} ${index} node reg ${createHash('sha256').update(userData).digest('hex').slice(0, 8)}`
      ),
      reusable: false,
      expiry: 86400, // 1 day, since bare metal can take hours to deliver
      preauthorized: true,
      tags: [`tag:${provider}`, `tag:${STAGE_NAME}`, `tag:${pool.role}`]
    },
    { dependsOn: [tailscaleAcl] }
  );
  return renderUserData(registrationTailnetAuthKey.key);
}

/**
 * Removes a deleted server's devices from the tailnet. `getTailscaleHostname` reads the hostname
 * back from the deleted resource's outputs.
 */
export function createTailnetCleanupHook({
  name,
  provider,
  getTailscaleHostname
}: {
  name: string;
  provider: Provider;
  getTailscaleHostname: (oldOutputs: Record<string, unknown>) => string | undefined;
}) {
  return new $util.ResourceHook(name, async (serverOutput) => {
    const tailscaleHostname = getTailscaleHostname(
      serverOutput.oldOutputs as Record<string, unknown>
    );

    const { devices = [] } = await tailscale.getDevices({ namePrefix: tailscaleHostname ?? '' });
    const serverDevices = devices.filter(
      (device) =>
        device.hostname === tailscaleHostname &&
        device.tags.includes(`tag:${provider}`) &&
        device.tags.includes(`tag:${STAGE_NAME}`)
    );
    if (serverDevices.length > 0) {
      const deletedDevices = deleteTailscaleDevices(
        ...serverDevices.map((device) => device.nodeId)
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
            `Deleted Tailscale devices:\n${serverDevices
              .filter((device) => deletedDeviceIds.includes(device.nodeId))
              .map((device) => device.name)
              .join('\n')}`
          );
        }
        if (failedToDeleteDeviceIds.length) {
          console.log(
            `Failed to delete Tailscale devices:\n${serverDevices
              .filter((device) => failedToDeleteDeviceIds.includes(device.nodeId))
              .map((device) => device.name)
              .join('\n')}`
          );
        }
      });
    }
  });
}
