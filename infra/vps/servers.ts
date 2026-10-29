import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../tailscale';
import { STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { backupBucket, s3Endpoint } from '../storage';
import { renderCloudInit } from '../utils';

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');

export type Provider = 'hetzner' | 'ovh' | 'latitude';
export type NodeType = 'control-plane' | 'worker' | 'database';
export type NodeCounts = Record<NodeType, number>;

export const PRIVATE_IP_RANGE = '10.0.1.0/24';
// NOTE: nodes take 10.0.1.<start + index>: up to 10 control plane, 180 worker, and 55 database nodes
export const NODE_IP_STARTS: Record<NodeType, number> = {
  'control-plane': 10,
  worker: 20,
  database: 200
};
export const NODE_RESOURCE_NAMES: Record<NodeType, string> = {
  'control-plane': 'ControlPlane',
  worker: 'Worker',
  database: 'Database'
};
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

export function getNodeIp({ type, index }: { type: NodeType; index: number }) {
  return `${PRIVATE_IP_RANGE.split('.').slice(0, 3).join('.')}.${NODE_IP_STARTS[type] + index}`;
}

/**
 * Creates the node's one-time Tailscale key and renders cloud-config.yaml for it. `privateNetplan`
 * is base64 netplan for the private interface, or '' when the provider configures it.
 */
export function createNodeUserData({
  provider,
  type,
  index,
  privateInterface,
  privateNetplan
}: {
  provider: Provider;
  type: NodeType;
  index: number;
  privateInterface: string;
  privateNetplan: $util.Input<string>;
}): { userData: $util.Output<string>; tailscaleHostname: string } {
  const role = type === 'control-plane' ? (index === 0 ? 'bootstrap' : 'server') : 'worker';
  const tailscaleHostname = `${STAGE_NAME}-${provider}-${type}-${index}`;

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
          SERVER_API: `https://${getNodeIp({ type: 'control-plane', index: 0 })}:6443`,
          NODE_IP: getNodeIp({ type, index }),
          PRIVATE_INTERFACE: privateInterface,
          PRIVATE_NETPLAN,
          K3S_AGENT_ARGS:
            type === 'database' ? '--node-label=role=db --node-taint=role=db:NoSchedule' : '',
          ROLE: role,
          TAILSCALE_HOSTNAME: tailscaleHostname,
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
    `${PROVIDER_RESOURCE_NAMES[provider]}${NODE_RESOURCE_NAMES[type]}Server${index}TailnetRegistrationAuthKey`,
    {
      // NOTE: the hash swaps in a fresh single-use key whenever new user data rebuilds the node
      description: renderUserData('').apply(
        (userData) =>
          `${PROVIDER_KEY_DESCRIPTIONS[provider]} ${type} ${index} node reg ${createHash('sha256').update(userData).digest('hex').slice(0, 8)}`
      ),
      reusable: false,
      expiry: 86400, // 1 day, since bare metal can take hours to deliver
      preauthorized: true,
      tags: [`tag:${provider}`, `tag:${STAGE_NAME}`, `tag:${type}`]
    },
    { dependsOn: [tailscaleAcl] }
  );
  const userData = renderUserData(registrationTailnetAuthKey.key);

  return { userData, tailscaleHostname };
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
