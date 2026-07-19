import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../tailscale';
import { STAGE_NAME } from '../dns';
import { secrets } from '../secrets';
import { backupBucket, s3Endpoint } from '../storage';
import {
  renderCloudInitTransport,
  renderDedicatedTransport,
  type BootstrapEnvironment
} from './bootstrap-render';
import type { ClusterNodeSpec } from './types';

const bootstrapScript = readFileSync(`${process.cwd()}/infra/cluster/bootstrap.sh`, 'utf8');

export const deleteServerFromTailnet = new $util.ResourceHook(
  'DeleteServerFromTailnet',
  async (serverOutput) => {
    const outputs = serverOutput.oldOutputs as {
      name?: string;
      displayName?: string;
    };
    const hostname = outputs.displayName ?? outputs.name ?? '';
    if (!hostname) return;
    const devices = await tailscale.getDevices({ namePrefix: hostname });
    const matching = devices.devices.filter(
      (device) =>
        device.hostname === hostname &&
        device.tags.includes('tag:ovh') &&
        device.tags.includes(`tag:${STAGE_NAME}`)
    );
    if (matching.length) {
      deleteTailscaleDevices(...matching.map((device) => device.nodeId));
    }
  }
);

export function createNodeBootstrap(args: {
  node: ClusterNodeSpec;
  apiAddress: $util.Input<string>;
  networkCidr: string;
  networkMode: 'dhcp' | 'static';
  vrackMac?: $util.Input<string>;
  dependsOn: $util.Resource[];
}): {
  cloudInit: $util.Output<string>;
  dedicatedPostInstall: $util.Output<string>;
  tailnetKey: tailscale.TailnetKey;
} {
  const tailnetKey = new tailscale.TailnetKey(
    `${args.node.logicalName}TailnetRegistrationAuthKey`,
    {
      description: `ovh ${args.node.pool.name} ${args.node.poolIndex} registration`,
      reusable: false,
      expiry: 1800,
      preauthorized: true,
      tags: [
        'tag:ovh',
        `tag:${STAGE_NAME}`,
        `tag:${args.node.role}`,
        `tag:${args.node.provider}`,
        `tag:${args.node.pool.name}`
      ]
    },
    { dependsOn: [tailscaleAcl, ...args.dependsOn] }
  );

  const payload = $resolve([
    args.apiAddress,
    args.vrackMac ?? '',
    secrets.Stage.value,
    secrets.ovh.K3sToken.value,
    tailnetKey.key,
    secrets.k8s.tailscale.OauthClientId.value,
    secrets.k8s.tailscale.OauthClientSecret.value,
    s3Endpoint
  ]).apply(
    ([
      apiAddress,
      vrackMac,
      stageName,
      k3sToken,
      registrationKey,
      operatorClientId,
      operatorClientSecret,
      backupEndpoint
    ]) =>
      $resolve([
        backupBucket.name,
        secrets.cloudflare.BackupAccessKey.value,
        secrets.cloudflare.BackupSecretKey.value
      ]).apply(([bucketName, backupAccessKey, backupSecretKey]) => {
        const environment: BootstrapEnvironment = {
          STAGE_NAME: stageName,
          NODE_NAME: args.node.hostname,
          NODE_IP: args.node.privateIp,
          NETWORK_CIDR: args.networkCidr,
          NETWORK_MODE: args.networkMode,
          VRACK_MAC: vrackMac,
          ROLE: args.node.role,
          BOOTSTRAP_CANDIDATE: String(args.node.bootstrapCandidate),
          SERVER_API: `https://${apiAddress}:6443`,
          K3S_TOKEN: k3sToken,
          REGISTRATION_TAILNET_AUTH_KEY: registrationKey,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID: operatorClientId,
          KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET: operatorClientSecret,
          KUBERNETES_TAILSCALE_HOSTNAME: `${stageName}-cluster`,
          S3_HOST: backupEndpoint,
          BACKUP_BUCKET: bucketName,
          S3_ACCESS_KEY: backupAccessKey,
          S3_SECRET_KEY: backupSecretKey
        };
        return {
          cloudInit: renderCloudInitTransport(bootstrapScript, environment),
          dedicatedPostInstall: renderDedicatedTransport(bootstrapScript, environment)
        };
      })
  );

  return {
    cloudInit: payload.apply((value) => value.cloudInit),
    dedicatedPostInstall: payload.apply((value) => value.dedicatedPostInstall),
    tailnetKey
  };
}
