import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../../tailscale';
import { STAGE_NAME } from '../../utils';
import { secrets } from '../../secrets';
import { backupBucket, s3Endpoint } from '../../storage';
import { cloudflareIpv4Cidrs } from '../../dns';
import type { ClusterNodeSpec, RegionalClusterPlan } from '../topology';

const bootstrapScript = readFileSync(
  `${process.cwd()}/infra/cluster/providers/bootstrap.sh`,
  'utf8'
);
const BOOTSTRAP_ENVIRONMENT_MARKER = '# PANDOKS_BOOTSTRAP_ENVIRONMENT';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderBootstrapScript(environment: Readonly<Record<string, string>>): string {
  return bootstrapScript.replace(
    BOOTSTRAP_ENVIRONMENT_MARKER,
    Object.entries(environment)
      .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
      .join('\n')
  );
}

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
  cluster: RegionalClusterPlan;
  node: ClusterNodeSpec;
  apiAddress: $util.Input<string>;
  networkCidr: $util.Input<string>;
  networkMode: 'dhcp' | 'static';
  vrackMac?: $util.Input<string>;
  dependsOn: $util.Resource[];
}) {
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
        `tag:${args.node.pool.role}`,
        `tag:${args.node.pool.provider}`,
        `tag:${args.node.pool.name}`
      ]
    },
    { dependsOn: [tailscaleAcl, ...args.dependsOn] }
  );

  const script = $resolve([
    args.apiAddress,
    args.networkCidr,
    args.vrackMac ?? '',
    secrets.ovh.K3sTokens[args.cluster.config.id].value,
    tailnetKey.key,
    secrets.k8s.tailscale.OauthClientId.value,
    secrets.k8s.tailscale.OauthClientSecret.value,
    s3Endpoint,
    backupBucket.name,
    secrets.cloudflare.BackupAccessKey.value,
    secrets.cloudflare.BackupSecretKey.value
  ]).apply(
    ([
      apiAddress,
      networkCidr,
      vrackMac,
      k3sToken,
      registrationKey,
      operatorClientId,
      operatorClientSecret,
      backupEndpoint,
      bucketName,
      backupAccessKey,
      backupSecretKey
    ]) =>
      renderBootstrapScript({
        STAGE_NAME,
        CLUSTER_REGION: args.cluster.config.id,
        CLUSTER_OPERATOR_HOSTNAME: args.cluster.identity.operatorHostname,
        CLUSTER_POD_CIDR: args.cluster.config.podCidr,
        CLUSTER_SERVICE_CIDR: args.cluster.config.serviceCidr,
        ETCD_BACKUP_FOLDER: args.cluster.identity.etcdBackupFolder,
        VRACK_VLAN_ID: String(args.cluster.config.vlanId),
        NODE_NAME: args.node.hostname,
        NODE_IP: args.node.privateIp,
        NETWORK_CIDR: networkCidr,
        NETWORK_MODE: args.networkMode,
        VRACK_MAC: vrackMac,
        ROLE: args.node.pool.role,
        WORKLOAD: args.node.pool.workload,
        PUBLIC_INGRESS: String(args.node.pool.publicIngress),
        BOOTSTRAP_CANDIDATE: String(args.node.bootstrapCandidate),
        DIRECT_INGRESS: String(args.node.directIngress),
        CLOUDFLARE_IPV4_CIDRS: cloudflareIpv4Cidrs.join(', '),
        SERVER_API: `https://${apiAddress}:6443`,
        K3S_TOKEN: k3sToken,
        REGISTRATION_TAILNET_AUTH_KEY: registrationKey,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID: operatorClientId,
        KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET: operatorClientSecret,
        S3_HOST: backupEndpoint,
        BACKUP_BUCKET: bucketName,
        S3_ACCESS_KEY: backupAccessKey,
        S3_SECRET_KEY: backupSecretKey
      })
  );

  return script;
}
