import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../tailscale';
import { isProduction, STAGE_NAME } from '../dns';
import { OVH_CLOUD_PROJECT_SERVICE } from '../ovh';
import { secrets } from '../secrets';
import { backupBucket, s3Endpoint } from '../storage';
import { renderCloudInit } from '../utils';

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');

export const deleteServerFromTailnet = new $util.ResourceHook(
  'DeleteServerFromTailnet',
  async (serverOutput) => {
    const outputs = serverOutput.oldOutputs as {
      name: $util.Unwrap<ovh.cloudproject.Instance['name']>;
    };
    // NOTE: instance names double as tailscale hostnames so the hook can find the devices
    const serverName = outputs.name ?? '';

    const devices = await tailscale.getDevices({ namePrefix: serverName });
    const serverOvhDevices = devices.devices.filter(
      (device) => device.tags.includes('tag:ovh') && device.tags.includes(`tag:${STAGE_NAME}`)
    );
    if (serverOvhDevices.length > 0) {
      const deletedDevices = deleteTailscaleDevices(
        ...serverOvhDevices.map((device) => device.nodeId)
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
            `Deleted Tailscale devices:\n${serverOvhDevices
              .filter((device) => deletedDeviceIds.includes(device.nodeId))
              .map((device) => device.name)
              .join('\n')}`
          );
        }
        if (failedToDeleteDeviceIds.length) {
          console.log(
            `Failed to delete Tailscale devices:\n${serverOvhDevices
              .filter((device) => failedToDeleteDeviceIds.includes(device.nodeId))
              .map((device) => device.name)
              .join('\n')}`
          );
        }
      });
    }
  }
);

export function createServers(
  serverArgs: {
    type: 'control-plane' | 'worker';
    serverCount: number;
    ips: string[];
    network: { networkId: $util.Output<string>; subnetId: $util.Output<string>; cidr: string };
  },
  ovhInstanceArgs: {
    flavorId: string;
    imageId: string;
    region: string;
  },
  bootstrap: { ip: string | undefined; server: ovh.cloudproject.Instance | undefined }
): { tailscaleHostnames: string[]; servers: ovh.cloudproject.Instance[] } {
  if (serverArgs.serverCount < 1) {
    return { tailscaleHostnames: [], servers: [] };
  } else if (serverArgs.type === 'control-plane' && serverArgs.serverCount > 10) {
    throw new Error(
      `You can only have 10 control plane nodes. Please reduce the number of control plane nodes. Currently: ${serverArgs.serverCount}`
    );
  }

  const tailscaleHostnames: string[] = [];
  const servers: ovh.cloudproject.Instance[] = [];

  const nodeResourceName = serverArgs.type === 'control-plane' ? 'ControlPlane' : 'Worker';

  for (let i = 0; i < serverArgs.serverCount; i++) {
    const serverRole: 'bootstrap' | 'server' | 'worker' =
      serverArgs.type === 'control-plane' ? (i === 0 ? 'bootstrap' : 'server') : 'worker';

    const ip = serverArgs.ips[i];
    const clusterTailscaleHostname = `${STAGE_NAME}-cluster`;
    if (serverRole === 'bootstrap') {
      bootstrap.ip = ip;
    }

    const registrationTailnetAuthKey = new tailscale.TailnetKey(
      `Ovh${nodeResourceName}Server${i}TailnetRegistrationAuthKey`,
      {
        description: `ovh ${serverArgs.type} ${i} node reg`,
        reusable: false,
        expiry: 1800, // 30 minutes
        preauthorized: true,
        tags: ['tag:ovh', `tag:${STAGE_NAME}`, `tag:${serverArgs.type}`]
      },
      { dependsOn: [tailscaleAcl] }
    );

    const tailscaleHostname = `${STAGE_NAME}-ovh-${serverArgs.type}-server-${i}`;
    tailscaleHostnames.push(tailscaleHostname);

    const userData = $resolve([
      secrets.Stage.value,
      secrets.ovh.K3sToken.value,
      registrationTailnetAuthKey.key,
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
        REGISTRATION_TAILNET_AUTH_KEY,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET,
        S3_HOST,
        BACKUP_BUCKET,
        S3_ACCESS_KEY,
        S3_SECRET_KEY
      ]) => {
        const environments = {
          STAGE_NAME,
          PRIVATE_IP_RANGE: serverArgs.network.cidr,
          K3S_TOKEN,
          SERVER_API: `https://${bootstrap.ip}:6443`,
          NODE_IP: ip,
          ROLE: serverRole,
          TAILSCALE_HOSTNAME: tailscaleHostname,
          REGISTRATION_TAILNET_AUTH_KEY,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET,
          KUBERNETES_TAILSCALE_HOSTNAME: clusterTailscaleHostname,
          S3_HOST,
          BACKUP_BUCKET,
          S3_ACCESS_KEY,
          S3_SECRET_KEY
        };
        return renderCloudInit(cloudInitConfig, environments);
      }
    );

    const dependencies = [bootstrap.server, servers.at(-1)].filter(
      (resource) => resource !== undefined
    );

    const server = new ovh.cloudproject.Instance(
      `Ovh${nodeResourceName}Server${i}`,
      {
        serviceName: OVH_CLOUD_PROJECT_SERVICE,
        name: tailscaleHostname,
        region: ovhInstanceArgs.region,
        billingPeriod: 'hourly',
        flavor: { flavorId: ovhInstanceArgs.flavorId },
        bootFrom: { imageId: ovhInstanceArgs.imageId },
        network: {
          public: true,
          private: {
            ip,
            network: { id: serverArgs.network.networkId, subnetId: serverArgs.network.subnetId }
          }
        },
        userData
      },
      {
        dependsOn: dependencies,
        ignoreChanges: isProduction ? ['userData'] : [],
        protect: isProduction,
        hooks: {
          afterDelete: [deleteServerFromTailnet]
        }
      }
    );
    bootstrap.server = bootstrap.server ?? server;
    servers.push(server);
  }

  return { tailscaleHostnames, servers };
}
