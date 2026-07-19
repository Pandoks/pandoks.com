import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CLUSTER_ADDRESS_PLAN,
  CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP,
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY,
  CLUSTER_NETWORK_DHCP_CONSUMERS,
  getClusterDhcpAllocationDemand
} from './types.ts';

const cluster = readFileSync('infra/cluster/cluster.ts', 'utf8');
const publicCloud = readFileSync('infra/cluster/providers/public-cloud.ts', 'utf8');
const dedicated = readFileSync('infra/cluster/providers/dedicated.ts', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const runbook = readFileSync('infra/cluster/README.md', 'utf8');
const secrets = readFileSync('infra/secrets.ts', 'utf8');
const cloudflare = readFileSync('infra/cloudflare.ts', 'utf8');
const credentials = readFileSync('k3s/base/core/credentials.yaml', 'utf8');
const network = readFileSync('infra/cluster/network.ts', 'utf8');
const metalLb = readFileSync('k3s/base/core/metallb.yaml', 'utf8');
const loadBalancers = readFileSync('infra/cluster/load-balancers.ts', 'utf8');
const ingress = readFileSync('k3s/bootstrap/core/haproxy-ingress.yaml', 'utf8');
const checksWorkflow = readFileSync('.github/workflows/checks.yaml', 'utf8');
const deployWorkflow = readFileSync('.github/workflows/deploy-infra.yaml', 'utf8');
const devVpsRunbook = readFileSync('scripts/dev-vps/README.md', 'utf8');
const devVpsCleanup = readFileSync('scripts/dev-vps/cleanup-state.sh', 'utf8');

void test('passes exact per-node protection through both provider adapters', () => {
  assert.match(cluster, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
  assert.match(cluster, /protect: isClusterNodeProtected\(/);
  assert.equal(publicCloud.match(/protect: args\.protect/g)?.length, 1);
  assert.equal(dedicated.match(/protect: args\.protect/g)?.length, 2);
});

void test('declares the non-secret targeted unprotect control', () => {
  assert.match(envExample, /^OVH_UNPROTECTED_NODE_LOGICAL_NAME=$/m);
});

void test('runbook maps all pools and derives only the highest-index target', () => {
  for (const mapping of [
    [
      'cloud-control-plane',
      'cloudControlPlaneCount',
      'prod-ovh-control-plane-server-',
      'OvhControlPlaneServer'
    ],
    ['cloud-workers', 'cloudWorkerCount', 'prod-ovh-worker-server-', 'OvhWorkerServer'],
    [
      'dedicated-control-plane',
      'dedicatedControlPlaneCount',
      'prod-ovh-dedicated-control-plane-server-',
      'OvhDedicatedControlPlaneServer'
    ],
    [
      'dedicated-workers',
      'dedicatedWorkerCount',
      'prod-ovh-dedicated-worker-server-',
      'OvhDedicatedWorkerServer'
    ]
  ]) {
    const cells = mapping.map((value) => `\\s*\\\`${value}\\\`\\s*`).join('\\|');
    assert.match(runbook, new RegExp(`\\|${cells}\\|`));
  }
  assert.match(runbook, /TARGET_INDEX=\$\(\(POOL_COUNT - 1\)\)/);
  assert.doesNotMatch(runbook, /read -r (NODE_NAME|LOGICAL_NAME)/);
});

void test('runbook documents the exact two-step unprotect transition', () => {
  assert.match(runbook, /OVH_UNPROTECTED_NODE_LOGICAL_NAME=OvhDedicatedControlPlaneServer2/);
  assert.match(runbook, /Keep all four pool counts unchanged/);
  assert.match(runbook, /Reduce only the selected pool count by exactly one/);
  assert.match(runbook, /does not match a currently declared highest-index node/);
  assert.match(runbook, /Clear `OVH_UNPROTECTED_NODE_LOGICAL_NAME`/);
});

void test('runbook stops the exact worker agent before deleting its node', () => {
  const start = runbook.indexOf('### Remove a worker target');
  const end = runbook.indexOf('### Remove a control-plane target');
  const targetedUnprotect = runbook.indexOf('### Two-step targeted unprotect and deletion');
  assert.ok(start >= 0 && end > start && targetedUnprotect > end);
  const section = runbook.slice(start, end);
  const drain = section.indexOf('kubectl drain "${NODE_NAME}"');
  const tailscale = section.indexOf('tailscale ssh "pandoks@${NODE_NAME}"');
  const stop = section.indexOf('sudo systemctl stop k3s-agent');
  const inspect = section.indexOf('AGENT_STATE="$(sudo systemctl is-active k3s-agent || true)"');
  const inactive = section.indexOf('[ "${AGENT_STATE}" = inactive ]');
  const deleteNode = section.indexOf('kubectl delete node "${NODE_NAME}"');

  assert.ok(drain >= 0);
  assert.ok(drain < tailscale);
  assert.ok(tailscale < stop);
  assert.ok(stop < inspect);
  assert.ok(inspect < inactive);
  assert.ok(inactive < deleteNode);
  assert.ok(start + deleteNode < targetedUnprotect);
});

void test('runbook orders control-plane etcd removal commands safely', () => {
  const start = runbook.indexOf('### Remove a control-plane target');
  const end = runbook.indexOf('### Two-step targeted unprotect and deletion');
  assert.ok(start >= 0 && end > start);
  const section = runbook.slice(start, end);
  const snapshot = section.indexOf('sudo k3s etcd-snapshot save');
  const memberListBefore = section.indexOf('etcdctl_k3s member list');
  const healthBefore = section.indexOf('etcdctl_k3s endpoint health --cluster');
  const drain = section.indexOf('kubectl drain "${NODE_NAME}"');
  const stop = section.indexOf('sudo systemctl stop k3s');
  const remove = section.indexOf('etcdctl_k3s member remove "${MEMBER_ID}"');
  const deleteNode = section.indexOf('kubectl delete node "${NODE_NAME}"');
  const memberListAfter = section.lastIndexOf('etcdctl_k3s member list');
  const healthAfter = section.lastIndexOf('etcdctl_k3s endpoint health --cluster');

  assert.ok(snapshot < memberListBefore);
  assert.ok(memberListBefore < healthBefore);
  assert.ok(healthBefore < drain);
  assert.ok(drain < stop);
  assert.ok(stop < remove);
  assert.ok(remove < deleteNode);
  assert.ok(deleteNode < memberListAfter);
  assert.ok(memberListAfter < healthAfter);
});

void test('retains legacy origin TLS state identities and aligned Kubernetes placeholders', () => {
  assert.match(
    secrets,
    /OriginTlsKey:\s*new sst\.Secret\('HetznerOriginTlsKey',\s*'No Origin Tls Key Set'\)/
  );
  assert.match(
    secrets,
    /OriginTlsCrt:\s*new sst\.Secret\('HetznerOriginTlsCrt',\s*'No Origin Tls Cert Set'\)/
  );
  assert.doesNotMatch(secrets, /new sst\.Secret\('OvhOriginTls(?:Key|Crt)'/);
  assert.match(cloudflare, /secrets\.k8s\.OriginTlsKey/);
  assert.match(cloudflare, /secrets\.k8s\.OriginTlsCrt/);
  assert.match(
    cloudflare,
    /aliases:\s*\[\s*\{\s*name:\s*'HetznerOriginCloudflareCaCertificate'\s*\}\s*\]/
  );
  assert.match(credentials, /\$\{HetznerOriginTlsCrt \| base64\}/);
  assert.match(credentials, /\$\{HetznerOriginTlsKey \| base64\}/);
  assert.doesNotMatch(credentials, /\$\{OvhOriginTls/);
  assert.match(runbook, /intentional legacy.*HetznerOriginTlsKey/is);
  assert.match(runbook, /HetznerOriginCloudflareCaCertificate/);
});

void test('keeps network, node pools, and MetalLB on one non-overlapping address plan', () => {
  assert.match(network, /CLUSTER_ADDRESS_PLAN\.dhcp\.start/);
  assert.match(network, /CLUSTER_ADDRESS_PLAN\.dhcp\.end/);
  assert.match(cluster, /CLUSTER_ADDRESS_PLAN\['cloud-control-plane'\]\.start/);
  assert.match(cluster, /CLUSTER_ADDRESS_PLAN\['cloud-workers'\]\.start/);
  assert.match(cluster, /CLUSTER_ADDRESS_PLAN\['dedicated-control-plane'\]\.start/);
  assert.match(cluster, /CLUSTER_ADDRESS_PLAN\['dedicated-workers'\]\.start/);
  assert.match(metalLb, /10\.0\.1\.100-10\.0\.1\.149/);
  assert.doesNotMatch(metalLb, /10\.0\.1\.100-10\.0\.1\.200/);
  assert.match(runbook, /DHCP.*\.2-.99/is);
  assert.match(runbook, /MetalLB.*\.100-.149/is);
  assert.match(runbook, /dedicated control-plane.*\.150-.199/is);
  assert.match(runbook, /dedicated worker.*\.200-.254/is);
});

void test('topology validation and load balancers share capacity constants and demand formula', () => {
  assert.deepEqual(CLUSTER_ADDRESS_PLAN, {
    dhcp: { start: 2, end: 99 },
    metalLb: { start: 100, end: 149 },
    'cloud-control-plane': { start: 10, end: 49 },
    'cloud-workers': { start: 50, end: 99 },
    'dedicated-control-plane': { start: 150, end: 199 },
    'dedicated-workers': { start: 200, end: 254 }
  });
  assert.equal(CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY, 25);
  assert.equal(CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP, 1);
  assert.equal(CLUSTER_NETWORK_DHCP_CONSUMERS, 2);
  assert.match(loadBalancers, /CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY/);
  assert.doesNotMatch(loadBalancers, /MEMBER_CAPACITY\s*=\s*25/);
  const representativeNodes = [
    ...Array.from({ length: 3 }, () => ({
      provider: 'public-cloud' as const,
      role: 'control-plane' as const,
      ingress: true
    })),
    ...Array.from({ length: 4 }, () => ({
      provider: 'public-cloud' as const,
      role: 'worker' as const,
      ingress: true
    })),
    ...Array.from({ length: 2 }, () => ({
      provider: 'dedicated' as const,
      role: 'control-plane' as const,
      ingress: true
    })),
    {
      provider: 'dedicated' as const,
      role: 'worker' as const,
      ingress: true
    }
  ];
  assert.equal(getClusterDhcpAllocationDemand(representativeNodes), 11);
});

void test('cluster monitoring matches the disabled default topology', () => {
  const monitoring = readFileSync('k3s/overlays/cluster/prom-etcd-config.yaml', 'utf8');
  assert.match(cluster, /getClusterStageConfig\(isProduction\)/);
  assert.doesNotMatch(cluster, /process\.env\.OVH_(?:CLOUD|DEDICATED)_/);
  assert.match(monitoring, /^\s*endpoints:\s*\[\]\s*$/m);
  assert.match(runbook, /kubeEtcd.*exact active control-plane IPs/is);
  assert.match(runbook, /operator pre-deploy step/i);
});

void test('enables PROXY v2 on both OVH load balancers and HAProxy Ingress', () => {
  assert.match(loadBalancers, /protocol:\s*'proxyV2'/);
  assert.match(ingress, /use-proxy-protocol:\s*"true"/);
});

void test('keeps topology in code and credentials in both CI SST environments', () => {
  const topologyVariables = [
    'OVH_CLOUD_CONTROL_PLANE_COUNT',
    'OVH_CLOUD_WORKER_COUNT',
    'OVH_DEDICATED_CONTROL_PLANE_COUNT',
    'OVH_DEDICATED_WORKER_COUNT',
    'OVH_DEDICATED_SERVER_PLAN',
    'OVH_DEDICATED_DATACENTER',
    'OVH_DEDICATED_ORDER_REGION',
    'OVH_DEDICATED_PLAN_OPTIONS'
  ];

  for (const workflow of [checksWorkflow, deployWorkflow]) {
    for (const variable of topologyVariables) {
      assert.doesNotMatch(workflow, new RegExp(variable));
    }
    assert.doesNotMatch(workflow, /scripts\/cluster\/validate-topology-env\.sh/);
    assert.match(workflow, /OVH_APPLICATION_SECRET:\s*\$\{\{ secrets\.OVH_APPLICATION_SECRET \}\}/);
    assert.match(workflow, /OVH_CONSUMER_KEY:\s*\$\{\{ secrets\.OVH_CONSUMER_KEY \}\}/);
    assert.match(
      workflow,
      /OVH_CLOUD_PROJECT_SERVICE:\s*\$\{\{ secrets\.OVH_CLOUD_PROJECT_SERVICE \}\}/
    );
    assert.doesNotMatch(workflow, /OVH_UNPROTECTED_NODE_LOGICAL_NAME:\s*\$\{\{/);
  }

  for (const variable of topologyVariables) {
    assert.doesNotMatch(envExample, new RegExp(`^${variable}=`, 'm'));
  }
  assert.match(envExample, /^OVH_UNPROTECTED_NODE_LOGICAL_NAME=$/m);
  assert.match(runbook, /infra\/cluster\/config\.ts/);
  assert.doesNotMatch(runbook, /GitHub environment variables/);
});

void test('dev cleanup script fails closed for exact Hetzner and OVH identity families', () => {
  for (const logicalName of [
    'HetznerDevBox',
    'HetznerDevBoxTailnetRegistrationAuthKey',
    'OvhDevBox',
    'OvhDevBoxTailnetRegistrationAuthKey'
  ]) {
    assert.match(devVpsCleanup, new RegExp(`resource_count ${logicalName}`));
    assert.match(devVpsCleanup, new RegExp(`-e ${logicalName}`));
  }
  assert.match(devVpsCleanup, /mix Hetzner and OVH families/);
  assert.match(devVpsCleanup, /hcloud:index\/server:Server/);
  assert.match(devVpsCleanup, /ovh:CloudProject\/instance:Instance/);
  assert.match(devVpsCleanup, /ovh:Vps\/vps:Vps/);
  assert.match(devVpsCleanup, /cd "\$\{REPOSITORY_ROOT\}"/);
  assert.match(devVpsCleanup, /stty -g < \/dev\/tty/);
  assert.match(devVpsCleanup, /stty -echo < \/dev\/tty/);
  assert.match(devVpsCleanup, /stty "\$\{TTY_STATE\}" < \/dev\/tty/);
  assert.match(devVpsCleanup, /retained-detach/);
  assert.match(devVpsCleanup, /already-deleted-stale/);
  assert.match(devVpsRunbook, /only authorized cleanup procedure/);
  assert.doesNotMatch(devVpsRunbook, /^\s*(?:\.\/node_modules\/\.bin\/)?sst state remove/m);
});
