import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLUSTER_ADDRESS_PLAN,
  CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP,
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY,
  CLUSTER_NETWORK_DHCP_CONSUMERS,
  getClusterDhcpAllocationDemand
} from '../cluster/types.ts';

const cluster = readFileSync('infra/cluster/cluster.ts', 'utf8');
const publicCloud = readFileSync('infra/cluster/providers/public-cloud.ts', 'utf8');
const dedicated = readFileSync('infra/cluster/providers/dedicated.ts', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const runbook = readFileSync('infra/cluster/README.md', 'utf8');
const secrets = readFileSync('infra/secrets.ts', 'utf8');
const githubInfra = readFileSync('infra/github.ts', 'utf8');
const ovhHelpers = readFileSync('infra/ovh.ts', 'utf8');
const cloudflare = readFileSync('infra/cloudflare.ts', 'utf8');
const credentials = readFileSync('k3s/base/core/credentials.yaml', 'utf8');
const network = readFileSync('infra/cluster/network.ts', 'utf8');
const metalLb = readFileSync('k3s/base/core/metallb.yaml', 'utf8');
const loadBalancers = readFileSync('infra/cluster/load-balancers.ts', 'utf8');
const ingress = readFileSync('k3s/bootstrap/core/haproxy-ingress.yaml', 'utf8');
const bootstrap = readFileSync('infra/cluster/bootstrap.ts', 'utf8');
const bootstrapScript = readFileSync('infra/cluster/bootstrap.sh', 'utf8');
const checksWorkflow = readFileSync('.github/workflows/checks.yaml', 'utf8');
const deployWorkflow = readFileSync('.github/workflows/deploy-infra.yaml', 'utf8');
const dev = readFileSync('infra/dev.ts', 'utf8');
const devVpsRunbook = readFileSync('scripts/dev-vps/README.md', 'utf8');
const devVpsCleanup = readFileSync('scripts/dev-vps/cleanup-state.sh', 'utf8');
const devVpsSetup = readFileSync('scripts/dev-vps/setup.sh', 'utf8');
const website = readFileSync('infra/website.ts', 'utf8');
const mise = readFileSync('mise.toml', 'utf8');
const renovate = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
  customManagers?: Array<Record<string, unknown>>;
  packageRules?: Array<Record<string, unknown>>;
};
const activeClusterRules = [
  readFileSync('.claude/rules/workflows.md', 'utf8'),
  readFileSync('.claude/rules/architecture.md', 'utf8'),
  readFileSync('.claude/rules/gotchas/cluster.md', 'utf8')
];

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

void test('centralizes shared stage helpers in infra/utils.ts', () => {
  const utilsPath = 'infra/utils.ts';
  assert.ok(existsSync(utilsPath), `${utilsPath} must own the shared stage helpers`);
  const utils = readFileSync(utilsPath, 'utf8');

  assert.match(utils, /export const isProduction = \$app\.stage === 'production'/);
  assert.match(utils, /export const domain = isProduction \? 'pandoks\.com' : 'dev\.pandoks\.com'/);
  assert.match(utils, /export const EXAMPLE_DOMAIN = 'example\.pandoks\.com'/);
  assert.match(utils, /export const STAGE_NAME = isProduction \? 'prod' : 'dev'/);

  for (const path of typescriptFiles('infra')) {
    if (path.startsWith('infra/tests/')) continue;
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /\b(?:APP_STAGE|isPandoks)\b/,
      `${path} must use isProduction or $app.stage directly`
    );
  }

  assert.match(cloudflare, /--stage \$\{\$app\.stage\}/);
  assert.match(secrets, /--stage \$\{\$app\.stage\}/);
});

void test('protects cluster resources only according to the deployment stage', () => {
  assert.doesNotMatch(
    cluster,
    /OVH_UNPROTECTED_NODE_LOGICAL_NAME|getUnprotectedNodeWarning|isClusterNodeProtected/
  );
  assert.match(cluster, /createPublicCloudNode\(\{[\s\S]*?protect: isProduction,/);
  assert.match(cluster, /createDedicatedNode\(\{[\s\S]*?protect: isProduction\s*\}\);/);
  assert.equal(publicCloud.match(/protect: args\.protect/g)?.length, 1);
  assert.equal(dedicated.match(/protect: args\.protect/g)?.length, 2);
});

void test('does not expose a production-protection bypass in the environment', () => {
  assert.doesNotMatch(envExample, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
});

void test('keeps the Pages and mise Node versions synchronized through Renovate', () => {
  const miseNodeVersion = mise.match(/^node = "([^"]+)"$/m)?.[1];
  const pagesNodeVersion = website.match(/const PAGES_NODE_VERSION = '([^']+)'/)?.[1];
  assert.ok(miseNodeVersion);
  assert.equal(pagesNodeVersion, miseNodeVersion);
  assert.match(website, /preview:\s*\{\s*envVars:\s*pagesBuildEnvironment\s*\}/s);
  assert.match(website, /production:\s*\{\s*envVars:\s*pagesBuildEnvironment\s*\}/s);
  assert.match(
    website,
    /NODE_VERSION:\s*\{\s*type:\s*'plain_text',\s*value:\s*PAGES_NODE_VERSION\s*\}/s
  );

  assert.deepEqual(
    renovate.customManagers?.find(
      (manager) => manager.description === 'Track the Cloudflare Pages Node version alongside mise'
    ),
    {
      customType: 'regex',
      description: 'Track the Cloudflare Pages Node version alongside mise',
      managerFilePatterns: ['/^infra\\/website\\.ts$/'],
      matchStrings: ["const PAGES_NODE_VERSION = '(?<currentValue>[\\d.]+)';"],
      depNameTemplate: 'node',
      datasourceTemplate: 'node-version',
      versioningTemplate: 'node'
    }
  );
  assert.deepEqual(
    renovate.packageRules?.find(
      (rule) => rule.description === 'Update the mise and Cloudflare Pages Node pins together'
    ),
    {
      description: 'Update the mise and Cloudflare Pages Node pins together',
      matchDatasources: ['node-version'],
      matchDepNames: ['node'],
      matchFileNames: ['mise.toml', 'infra/website.ts'],
      groupName: 'Node.js runtime',
      minimumGroupSize: 2
    }
  );
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

void test('runbook documents the stage-only production protection boundary', () => {
  assert.match(runbook, /Production node resources use `protect: isProduction`/);
  assert.match(runbook, /Every production node\s+remains protected/);
  assert.match(runbook, /There is no\s+environment-variable bypass/);
  assert.match(runbook, /Do not lower\s+the pool count or deploy the deletion/);
  assert.match(runbook, /separate reviewed IaC change/i);
  assert.doesNotMatch(runbook, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
});

void test('runbook stops the exact worker agent before deleting its node', () => {
  const start = runbook.indexOf('### Remove a worker target');
  const end = runbook.indexOf('### Remove a control-plane target');
  const protectionBoundary = runbook.indexOf('### Production protection boundary');
  assert.ok(start >= 0 && end > start && protectionBoundary > end);
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
  assert.ok(start + deleteNode < protectionBoundary);
});

void test('runbook orders control-plane etcd removal commands safely', () => {
  const start = runbook.indexOf('### Remove a control-plane target');
  const end = runbook.indexOf('### Production protection boundary');
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

void test('keeps topology and the Public Cloud project in code and only credentials in CI', () => {
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
    assert.doesNotMatch(workflow, /OVH_CLOUD_PROJECT_SERVICE/);
    assert.doesNotMatch(workflow, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
  }

  for (const variable of topologyVariables) {
    assert.doesNotMatch(envExample, new RegExp(`^${variable}=`, 'm'));
  }
  assert.doesNotMatch(envExample, /OVH_CLOUD_PROJECT_SERVICE/);
  assert.doesNotMatch(secrets, /CloudProjectService|OVH_CLOUD_PROJECT_SERVICE/);
  assert.doesNotMatch(githubInfra, /GithubOvhCloudProjectService|OVH_CLOUD_PROJECT_SERVICE/);
  assert.doesNotMatch(envExample, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
  assert.match(runbook, /infra\/cluster\/config\.ts/);
  assert.doesNotMatch(runbook, /GitHub environment variables/);
});

void test('creates the US Public Cloud project in Pulumi and threads its generated ID', () => {
  assert.match(ovhHelpers, /new ovh\.cloudproject\.Project\(\s*'OvhPublicCloudProject'/s);
  assert.match(ovhHelpers, /deletionProtection:\s*args\.protect/);
  assert.match(ovhHelpers, /ovhSubsidiary:\s*'US'/);
  assert.match(
    ovhHelpers,
    /plan:\s*\{\s*duration:\s*'P1M',\s*planCode:\s*'project',\s*pricingMode:\s*'default'\s*\}/s
  );
  assert.match(ovhHelpers, /\{\s*protect:\s*args\.protect\s*\}\s*\)/s);
  assert.doesNotMatch(ovhHelpers, /OVH_CLOUD_PROJECT_SERVICE|process\.env/);

  assert.match(
    cluster,
    /createOvhCloudProject\(\{\s*stageName:\s*STAGE_NAME,\s*protect:\s*isProduction/s
  );
  assert.match(cluster, /createClusterNetwork\(\{\s*serviceName:\s*cloudProject\.projectId,/s);
  assert.match(cluster, /CloudProjectId:\s*cloudProject\?\.projectId\s*\?\?\s*''/s);
  assert.match(network, /serviceName:\s*\$util\.Input<string>/);
  assert.match(network, /projectId:\s*args\.serviceName/);
  assert.match(loadBalancers, /serviceName\s*=\s*args\.network\.serviceName/);
  assert.match(loadBalancers, /flavorId:\s*\$util\.Input<string>/);
  assert.match(publicCloud, /serviceName:\s*args\.network\.serviceName/);
});

void test('deletes only the exact hostname returned by a Tailscale prefix query', () => {
  const query = bootstrap.indexOf('tailscale.getDevices({ namePrefix: hostname })');
  const exactHostname = bootstrap.indexOf('device.hostname === hostname', query);
  const nodeIds = bootstrap.indexOf('matching.map((device) => device.nodeId)', query);

  assert.ok(query >= 0);
  assert.ok(exactHostname > query);
  assert.ok(nodeIds > exactHostname);
});

void test('pins every k3s installer invocation to the approved exact release', () => {
  assert.match(bootstrapScript, /^K3S_VERSION='v1\.36\.2\+k3s1'$/m);
  assert.equal(bootstrapScript.match(/^K3S_VERSION=/gm)?.length, 1);
  assert.equal(bootstrapScript.match(/export INSTALL_K3S_VERSION="\$\{K3S_VERSION\}"/g)?.length, 1);

  const installer = bootstrapScript.match(/download_k3s_installer\(\) \{(?<body>[\s\S]*?)^\}/m)
    ?.groups?.body;
  assert.ok(installer);
  assert.match(installer, /export INSTALL_K3S_VERSION="\$\{K3S_VERSION\}"/);
});

void test('active cluster rules describe code-owned zero topology and CI contracts', () => {
  const deletedTopologyVariables =
    /OVH_(?:CLOUD_(?:CONTROL_PLANE|WORKER)_COUNT|DEDICATED_(?:CONTROL_PLANE_COUNT|WORKER_COUNT|SERVER_PLAN|DATACENTER|ORDER_REGION|PLAN_OPTIONS))/;

  for (const rules of activeClusterRules) {
    assert.doesNotMatch(rules, deletedTopologyVariables);
    assert.doesNotMatch(rules, /scripts\/cluster\/validate-topology-env\.sh/);
    assert.doesNotMatch(rules, /production defaults to one/i);
  }

  const rules = activeClusterRules.join('\n');
  assert.match(rules, /infra\/cluster\/config\.ts/);
  assert.match(rules, /PRODUCTION_CLUSTER_CONFIG/);
  assert.match(rules, /NON_PRODUCTION_CLUSTER_CONFIG/);
  assert.match(rules, /both currently\s+set all four counts to zero/i);
  assert.match(rules, /dedicated catalog fields[\s\S]*stage object[\s\S]*counts become non-zero/i);
  assert.match(
    rules,
    /OVH credentials[\s\S]*Public Cloud project[\s\S]*TypeScript topology contracts/i
  );
  assert.match(rules, /production[\s\S]*protect: isProduction[\s\S]*non-production/i);
  assert.doesNotMatch(rules, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
});

void test('CI runs all infra safety checks for manual VPS changes', () => {
  assert.match(checksWorkflow, /infra:\n(?:\s+- .*\n)*\s+- 'scripts\/dev-vps\/\*\*'/);
  for (const [name, command] of [
    ['Typecheck infra', 'pnpm check:infra'],
    ['Test infra', 'pnpm test:infra'],
    ['Test dev VPS cleanup', 'sh scripts/dev-vps/cleanup-state.test.sh'],
    ['Test dev VPS setup', 'sh scripts/dev-vps/setup.test.sh']
  ]) {
    assert.match(
      checksWorkflow,
      new RegExp(`- name: ${name}\\n\\s+run: ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
  }
});

void test('manual VPS setup accepts only Ubuntu 26.04 and reports the detected release', () => {
  assert.match(
    devVpsSetup,
    /\[ "\$\{detected_id\}" != "ubuntu" \] \|\| \[ "\$\{detected_version\}" != "26\.04" \]/
  );
  assert.match(devVpsSetup, /requires Ubuntu 26\.04/);
  assert.match(devVpsSetup, /ID=%s VERSION_ID=%s/);
});

void test('dev stage orders an annual protected VPS-4 with only standard options', () => {
  assert.match(dev, /if \(\$app\.stage === 'pandoks'\)/);
  assert.match(dev, /new ovh\.vps\.Vps\(\s*'OvhDevVps'/s);
  assert.match(dev, /planCode:\s*'vps-2027-model4'/);
  assert.match(dev, /label:\s*'vps_datacenter',\s*value:\s*'US-WEST-OR'/s);
  assert.match(dev, /label:\s*'vps_os',\s*value:\s*'Ubuntu 26\.04'/s);
  assert.match(dev, /planCode:\s*'option-linux'/);
  assert.match(dev, /planCode:\s*'option-auto-backup-2027-1-model4'/);
  assert.match(dev, /planCode:\s*'option-storage-local-2027-model4'/);
  assert.equal((dev.match(/duration:\s*'P1M'/g) ?? []).length, 4);
  assert.equal((dev.match(/pricingMode:\s*'upfront12'/g) ?? []).length, 4);
  assert.doesNotMatch(dev, /pricingMode:\s*'default'/);
  assert.doesNotMatch(dev, /option-(?:auto-backup-2027-7|snapshot|additional-disk)/);
  assert.match(dev, /doNotSendPassword:\s*false/);
  assert.doesNotMatch(dev, /publicSshKey|imageId|cloud-init|userData/i);
  assert.match(dev, /\{\s*protect:\s*true\s*\}\s*\)/s);
  assert.match(devVpsRunbook, /SST provisions and lifecycle-manages the VPS-4 subscription/);
  assert.match(devVpsRunbook, /Ubuntu 26\.04/);
  assert.match(devVpsRunbook, /12-month upfront pricing/);
  assert.match(
    devVpsRunbook,
    /setup\.sh.*does not order,\s*reinstall, resize, or delete the VPS/is
  );
});

void test('zero-node dev VPS does not require Public Cloud or k3s-only inputs', () => {
  assert.match(
    cluster,
    /shouldProvisionClusterInfrastructure\(\s*isProduction,\s*CLUSTER_CONFIG\s*\)/s
  );
  assert.match(cluster, /const cloudProject = provisionClusterInfrastructure\s*\?/s);
  assert.match(cluster, /const network = cloudProject\s*\?\s*createClusterNetwork\(/s);
  assert.match(
    secrets,
    /ApplicationSecret:\s*new sst\.Secret\(\s*'OvhApplicationSecret',\s*process\.env\.OVH_APPLICATION_SECRET\s*\)/s
  );
  assert.match(
    secrets,
    /ConsumerKey:\s*new sst\.Secret\(\s*'OvhConsumerKey',\s*process\.env\.OVH_CONSUMER_KEY\s*\)/s
  );
  assert.match(secrets, /const DISABLED_CLUSTER_PLACEHOLDER = 'unused-disabled-cluster'/);
  assert.doesNotMatch(secrets, /CloudProjectService|OVH_CLOUD_PROJECT_SERVICE/);
  assert.match(
    secrets,
    /K3sToken:\s*new sst\.Secret\(\s*'OvhK3sToken',\s*k3sTokenPlaceholder\s*\)/s
  );
  assert.match(devVpsRunbook, /does not require an OVH Public Cloud project or k3s token/i);
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
