import { readFileSync } from 'node:fs';
import { deleteTailscaleDevices, tailscaleAcl } from '../../tailscale';
import { STAGE_NAME } from '../../utils';
import { secrets } from '../../secrets';
import { backupBucket, s3Endpoint } from '../../storage';
import { cloudflareIpv4Cidrs } from '../../dns';
import type { ClusterNodeSpec, ClusterPlan } from '../topology';

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
  cluster: ClusterPlan;
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
  const k3sToken = secrets.ovh.K3sTokens[args.cluster.config.name];
  if (!k3sToken) {
    throw new Error(`Missing K3s token secret for cluster ${args.cluster.config.name}`);
  }
  const nodeLabels = Object.entries({
    ...args.node.pool.labels,
    'pandoks.com/public-ingress': String(args.node.pool.publicIngress)
  })
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  const nodeTaints = args.node.pool.taints
    .map(({ key, value, effect }) => `${key}=${value}:${effect}`)
    .join(',');
  const interconnect = args.cluster.interconnect;

  const script = $resolve([
    args.apiAddress,
    args.networkCidr,
    args.vrackMac ?? '',
    k3sToken.value,
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
      k3sTokenValue,
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
        CLUSTER_REGION: args.cluster.config.name,
        CLUSTER_OPERATOR_HOSTNAME: args.cluster.identity.operatorHostname,
        CLUSTER_POD_CIDR: args.cluster.network.podCidr,
        CLUSTER_SERVICE_CIDR: args.cluster.network.serviceCidr,
        ETCD_BACKUP_FOLDER: args.cluster.identity.etcdBackupFolder,
        VRACK_VLAN_ID: String(args.cluster.network.vlanId),
        NODE_NAME: args.node.hostname,
        NODE_IP: args.node.privateIp,
        NETWORK_CIDR: networkCidr,
        NETWORK_MODE: args.networkMode,
        VRACK_MAC: vrackMac,
        ROLE: args.node.pool.role,
        NODE_LABELS: nodeLabels,
        NODE_TAINTS: nodeTaints,
        INTERCONNECT_VLAN_ID:
          args.node.interconnectIp && interconnect ? String(interconnect.vlanId) : '',
        INTERCONNECT_IP: args.node.interconnectIp ?? '',
        INTERCONNECT_PREFIX_LENGTH:
          args.node.interconnectIp && interconnect ? String(interconnect.prefixLength) : '',
        INTERCONNECT_CIDR: args.node.interconnectIp && interconnect ? interconnect.cidr : '',
        BOOTSTRAP_CANDIDATE: String(args.node.bootstrapCandidate),
        DIRECT_INGRESS: String(args.node.directIngress),
        CLOUDFLARE_IPV4_CIDRS: cloudflareIpv4Cidrs.join(', '),
        SERVER_API: `https://${apiAddress}:6443`,
        K3S_TOKEN: k3sTokenValue,
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
