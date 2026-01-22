import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../tailscale';
import { isProduction, STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { backupBucket, s3Endpoint } from '../storage';

const cloudInitConfig = readFileSync(`${process.cwd()}/infra/vps/cloud-config.yaml`, 'utf8');

const deleteServerFromTailnet = new $util.ResourceHook(
  'DeleteServerFromTailnet',
  async (serverOutput) => {
    const outputs = serverOutput.oldOutputs as hcloud.Server;
    const serverLabels = outputs.labels ?? {};

    const devices = await tailscale.getDevices({
      namePrefix: `${serverLabels['tailscale'] ?? ''}`
    });
    const serverHetznerDevices = devices.devices.filter(
      (device) => device.tags.includes('tag:hetzner') && device.tags.includes(`tag:${STAGE_NAME}`)
    );
    if (serverHetznerDevices.length > 0) {
      const deletedDevices = await deleteTailscaleDevices(
        ...serverHetznerDevices.map((device) => device.nodeId)
      );
      deletedDevices.apply((deletedDevices) => {
        const deletedDeviceIds = deletedDevices
          .filter((device) => device.success)
          .map((device) => device.deviceId);
        const failedToDeleteDeviceIds = deletedDevices
          .filter((device) => !device.success)
          .map((device) => device.deviceId);
        if (deletedDeviceIds.length)
          console.log(
            `Deleted Tailscale devices:\n${serverHetznerDevices
              .filter((device) => deletedDeviceIds.includes(device.nodeId))
              .map((device) => device.name)
              .join('\n')}`
          );
        if (failedToDeleteDeviceIds.length)
          console.log(
            `Failed to delete Tailscale devices:\n${serverHetznerDevices
              .filter((device) => failedToDeleteDeviceIds.includes(device.nodeId))
              .map((device) => device.name)
              .join('\n')}`
          );
      });
    }
  }
);

export function createServers(
  serverArgs: {
    type: 'control-plane' | 'worker';
    serverCount: number;
    network: { network: hcloud.Network; subnet: hcloud.NetworkSubnet };
    startingOctet: number;
    loadBalancers: { loadbalancer: hcloud.LoadBalancer; network: hcloud.LoadBalancerNetwork }[];
  },
  hcloudServerArgs: {
    type: string;
    image: string;
    location: string;
    firewalls: hcloud.Firewall[];
  },
  bootstrap: { ip: $util.Input<string> | undefined; server: hcloud.Server | undefined }
): { tailscaleHostnames: string[]; servers: hcloud.Server[] } {
  if (serverArgs.serverCount < 1) {
    return { tailscaleHostnames: [], servers: [] };
  } else if (serverArgs.type === 'control-plane' && serverArgs.serverCount > 10) {
    throw new Error(
      `You can only have 10 control plane nodes. Please reduce the number of control plane nodes. Currently: ${serverArgs.serverCount}`
    );
  }

  let tailscaleHostnames: string[] = [];
  let servers: hcloud.Server[] = [];

  const nodeResourceName = serverArgs.type === 'control-plane' ? 'ControlPlane' : 'Worker';

  const placementGroups =
    serverArgs.type === 'control-plane'
      ? [
          new hcloud.PlacementGroup('HetznerControlPlanePlacementGroup', {
            name: 'control-plane',
            type: 'spread'
          })
        ]
      : Array.from({ length: Math.ceil(serverArgs.serverCount / 10) }).map((_, i) => {
          return new hcloud.PlacementGroup(`HetznerWorkerPlacementGroup${i}`, {
            name: `workers-${i}`,
            type: 'spread'
          });
        });

  for (let i = 0; i < serverArgs.serverCount; i++) {
    const serverRole: 'bootstrap' | 'server' | 'worker' =
      serverArgs.type === 'control-plane' ? (i === 0 ? 'bootstrap' : 'server') : 'worker';

    const ip = serverArgs.network.subnet.ipRange.apply(
      (ipRange) => `${ipRange.split('.').slice(0, 3).join('.')}.${serverArgs.startingOctet + i}`
    );
    const clusterTailscaleHostname = `${STAGE_NAME}-cluster`;
    if (serverRole === 'bootstrap') {
      bootstrap.ip = ip;
    }

    const registrationTailnetAuthKey = new tailscale.TailnetKey(
      `Hetzner${nodeResourceName}Server${i}TailnetRegistrationAuthKey`,
      {
        description: `hcloud ${serverArgs.type} ${i} node reg`,
        reusable: false,
        expiry: 1800, // 30 minutes
        preauthorized: true,
        tags: ['tag:hetzner', `tag:${STAGE_NAME}`, `tag:${serverArgs.type}`]
      },
      { dependsOn: [tailscaleAcl] }
    );

    const tailscaleHostname = `${STAGE_NAME}-hetzner-${serverArgs.type}-server-${i}`;
    tailscaleHostnames.push(tailscaleHostname);

    const userData = $resolve([
      secrets.Stage.value,
      serverArgs.network.subnet.ipRange,
      secrets.hetzner.K3sToken.value,
      ip,
      bootstrap.ip,
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
        PRIVATE_IP_RANGE,
        K3S_TOKEN,
        NODE_IP,
        bootstrapIp,
        REGISTRATION_TAILNET_AUTH_KEY,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET,
        S3_HOST,
        BACKUP_BUCKET,
        S3_ACCESS_KEY,
        S3_SECRET_KEY
      ]) => {
        const envs = {
          STAGE_NAME,
          PRIVATE_IP_RANGE,
          K3S_TOKEN,
          SERVER_API: `https://${bootstrapIp}:6443`,
          NODE_IP,
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
        return cloudInitConfig.replace(/\$\{([A-Z0-9_]+)\}/g, (_, capture) =>
          capture in envs ? envs[capture] : ''
        );
      }
    );

    const dependencies = [bootstrap.server, servers.at(-1)].filter(
      (resource) => resource !== undefined
    );

    const server = new hcloud.Server(
      `Hetzner${nodeResourceName}Server${i}`,
      {
        name: `${STAGE_NAME}-${serverArgs.type}-server-${i}`,
        serverType: hcloudServerArgs.type,
        image: hcloudServerArgs.image,
        location: hcloudServerArgs.location,
        placementGroupId: placementGroups[Math.floor(i / 10)].id.apply((id) => parseInt(id)),
        deleteProtection: isProduction,
        rebuildProtection: isProduction,
        firewallIds: hcloudServerArgs.firewalls.map((firewall) =>
          firewall.id.apply((id) => parseInt(id))
        ),
        networks: [{ networkId: serverArgs.network.network.id.apply((id) => parseInt(id)), ip }],
        publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
        shutdownBeforeDeletion: true,
        labels: { tailscale: tailscaleHostname },
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

  servers.forEach((server, index) => {
    for (const [i, { loadbalancer, network }] of serverArgs.loadBalancers.entries()) {
      new hcloud.LoadBalancerTarget(
        `HetznerK3s${nodeResourceName}LoadBalancer${i}Target${index}`,
        {
          loadBalancerId: loadbalancer.id.apply((id) => parseInt(id)),
          type: 'server',
          serverId: server.id.apply((id) => parseInt(id)),
          usePrivateIp: true
        },
        { dependsOn: [network] }
      );
    }
  });

  return { tailscaleHostnames, servers };
}
