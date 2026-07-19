import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLUSTER_ADDRESS_PLAN,
  CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP,
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY,
  CLUSTER_NETWORK_CIDR,
  CLUSTER_NETWORK_INFRASTRUCTURE_CONSUMERS,
  getClusterInfrastructureAllocationDemand
} from '../cluster/types.ts';

const cluster = readFileSync('infra/cluster/cluster.ts', 'utf8');
const clusterConfigModule = readFileSync('infra/cluster/config.ts', 'utf8');
const clusterTypes = readFileSync('infra/cluster/types.ts', 'utf8');
const publicCloud = readFileSync('infra/cluster/providers/public-cloud.ts', 'utf8');
const dedicated = readFileSync('infra/cluster/providers/dedicated.ts', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const secrets = readFileSync('infra/secrets.ts', 'utf8');
const githubInfra = readFileSync('infra/github.ts', 'utf8');
const cloudflare = readFileSync('infra/cloudflare.ts', 'utf8');
const credentials = readFileSync('k3s/base/core/credentials.yaml', 'utf8');
const certManager = readFileSync('k3s/base/core/cert-manager.yaml', 'utf8');
const clusterOriginTlsPath = 'k3s/overlays/cluster/origin-tls.yaml';
const clusterOriginTls = existsSync(clusterOriginTlsPath)
  ? readFileSync(clusterOriginTlsPath, 'utf8')
  : '';
const clusterOriginTlsPatchPath = 'k3s/overlays/cluster/origin-tls-patch.yaml';
const clusterOriginTlsPatch = existsSync(clusterOriginTlsPatchPath)
  ? readFileSync(clusterOriginTlsPatchPath, 'utf8')
  : '';
const clusterKustomization = readFileSync('k3s/overlays/cluster/kustomization.yaml', 'utf8');
const exampleApp = readFileSync('apps/example/kube/example.yaml', 'utf8');
const network = readFileSync('infra/cluster/network.ts', 'utf8');
const metalLb = readFileSync('k3s/base/core/metallb.yaml', 'utf8');
const loadBalancers = readFileSync('infra/cluster/load-balancers.ts', 'utf8');
const ingress = readFileSync('k3s/bootstrap/core/haproxy-ingress.yaml', 'utf8');
const bootstrap = readFileSync('infra/cluster/providers/bootstrap.ts', 'utf8');
const bootstrapScript = readFileSync('infra/cluster/providers/bootstrap.sh', 'utf8');
const checksWorkflow = readFileSync('.github/workflows/checks.yaml', 'utf8');
const deployWorkflow = readFileSync('.github/workflows/deploy-infra.yaml', 'utf8');
const dev = readFileSync('infra/dev.ts', 'utf8');
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

void test('delegates origin TLS issuance and rotation to cert-manager', () => {
  assert.doesNotMatch(secrets, /OriginTls(?:Key|Crt)|OvhOriginTls|HetznerOriginTls/);
  assert.doesNotMatch(cloudflare, /OriginCaCertificate|cluster\.origin|cluster\.openssl|OriginTls/);
  assert.doesNotMatch(credentials, /tls\.(?:crt|key):/);
  assert.doesNotMatch(credentials, /cloudflare-dns-api-token/);

  assert.match(
    certManager,
    /kind:\s*Certificate[\s\S]*name:\s*cloudflare-origin-tls[\s\S]*namespace:\s*example/
  );
  assert.match(
    certManager,
    /secretName:\s*cloudflare-origin-tls[\s\S]*dnsNames:\s*\n\s*-\s*example\.pandoks\.com[\s\S]*name:\s*internal-ca-issuer/
  );
  assert.match(certManager, /privateKey:\s*\n\s*rotationPolicy:\s*Always/);

  assert.match(clusterKustomization, /-\s*origin-tls\.yaml/);
  assert.match(clusterKustomization, /path:\s*origin-tls-patch\.yaml/);
  assert.match(clusterOriginTls, /server:\s*https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/);
  assert.match(
    clusterOriginTls,
    /privateKeySecretRef:\s*\n\s*name:\s*letsencrypt-production-account-key/
  );
  assert.match(
    clusterOriginTls,
    /kind:\s*Secret[\s\S]*name:\s*cloudflare-dns-api-token[\s\S]*namespace:\s*cert-manager[\s\S]*api-token:\s*\$\{CloudflareApiKey \| quote\}/
  );
  assert.match(
    clusterOriginTls,
    /apiTokenSecretRef:\s*\n\s*name:\s*cloudflare-dns-api-token\s*\n\s*key:\s*api-token/
  );
  assert.match(
    clusterOriginTlsPatch,
    /kind:\s*Certificate[\s\S]*name:\s*cloudflare-origin-tls[\s\S]*issuerRef:\s*\n\s*name:\s*letsencrypt-production/
  );
  assert.equal(exampleApp.match(/secretName:\s*cloudflare-origin-tls/g)?.length, 2);

  for (const path of [
    'infra/cluster/cluster.openssl.conf',
    'infra/cluster/cluster.origin.dev.csr',
    'infra/cluster/cluster.origin.prod.csr'
  ]) {
    assert.equal(existsSync(path), false, `${path} must be removed`);
  }
});

void test('keeps network, node pools, and MetalLB on one non-overlapping address plan', () => {
  assert.equal(CLUSTER_NETWORK_CIDR, '10.0.0.0/16');
  assert.match(network, /CLUSTER_ADDRESS_PLAN\.infrastructure\.thirdOctet/);
  assert.match(network, /CLUSTER_ADDRESS_PLAN\.infrastructure\.start/);
  assert.match(network, /CLUSTER_ADDRESS_PLAN\.infrastructure\.end/);
  assert.match(network, /formatClusterIp/);
  assert.match(cluster, /normalizeNodePools\(NODE_POOLS, STAGE_NAME, CLUSTER_NETWORK_CIDR\)/);
  assert.doesNotMatch(cluster, /privateIpStart/);
  assert.match(metalLb, /10\.0\.5\.1-10\.0\.5\.254/);
  assert.match(clusterTypes, /10\.0\.0\.x\s+OVH\/Neutron infrastructure/);
  assert.match(clusterTypes, /10\.0\.6\.x-10\.0\.255\.x\s+Reserved/);
  assert.match(bootstrapScript, /NETWORK_PREFIX_LENGTH="\$\{NETWORK_CIDR##\*\/\}"/);
  assert.match(bootstrapScript, /\$\{NODE_IP\}\/\$\{NETWORK_PREFIX_LENGTH\}/);
  assert.doesNotMatch(bootstrapScript, /\$\{NODE_IP\}\/24/);
});

void test('topology validation and load balancers share capacity constants and demand formula', () => {
  assert.deepEqual(CLUSTER_ADDRESS_PLAN, {
    infrastructure: { thirdOctet: 0, start: 2, end: 254 },
    'cloud-control-plane': { thirdOctet: 1, start: 1, end: 254 },
    'cloud-workers': { thirdOctet: 2, start: 1, end: 254 },
    'dedicated-control-plane': { thirdOctet: 3, start: 1, end: 254 },
    'dedicated-workers': { thirdOctet: 4, start: 1, end: 254 },
    metalLb: { thirdOctet: 5, start: 1, end: 254 },
    reserved: { startThirdOctet: 6, endThirdOctet: 255 }
  });
  assert.equal(CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY, 25);
  assert.equal(CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP, 1);
  assert.equal(CLUSTER_NETWORK_INFRASTRUCTURE_CONSUMERS, 2);
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
  assert.equal(getClusterInfrastructureAllocationDemand(representativeNodes), 4);
});

void test('cluster monitoring matches the disabled default topology', () => {
  const monitoring = readFileSync('k3s/overlays/cluster/prom-etcd-config.yaml', 'utf8');
  assert.match(
    clusterConfigModule,
    /export const clusterConfig = isProduction\s*\?\s*PRODUCTION_CLUSTER_CONFIG\s*:\s*NON_PRODUCTION_CLUSTER_CONFIG/
  );
  assert.match(
    clusterConfigModule,
    /export const clusterNodeCount = NODE_POOLS\.reduce\(\(total, pool\) => total \+ pool\.count, 0\)/
  );
  assert.doesNotMatch(cluster, /shouldProvisionClusterInfrastructure/);
  assert.doesNotMatch(clusterConfigModule, /getClusterStageConfig|getClusterNodeCount/);
  assert.doesNotMatch(
    cluster,
    /getClusterStageConfig|\bCLUSTER_CONFIG\b|PRODUCTION_CLUSTER_CONFIG|NON_PRODUCTION_CLUSTER_CONFIG/
  );
  assert.doesNotMatch(cluster, /process\.env\.OVH_(?:CLOUD|DEDICATED)_/);
  assert.match(monitoring, /^\s*endpoints:\s*\[\]\s*$/m);
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
});

void test('shares account-scoped OVH credentials through repository secrets', () => {
  assert.doesNotMatch(githubInfra, /RepositoryEnvironment|ActionsEnvironmentSecret/);
  assert.match(
    githubInfra,
    /if \(isProduction\) \{[\s\S]*new github\.ActionsSecret\('GithubOvhApplicationSecret', \{[\s\S]*secretName:\s*'OVH_APPLICATION_SECRET'/
  );
  assert.match(
    githubInfra,
    /if \(isProduction\) \{[\s\S]*new github\.ActionsSecret\('GithubOvhConsumerKey', \{[\s\S]*secretName:\s*'OVH_CONSUMER_KEY'/
  );

  for (const workflow of [checksWorkflow, deployWorkflow]) {
    assert.doesNotMatch(workflow, /^\s+environment:/m);
  }
});

void test('creates the US Public Cloud project in Pulumi and threads its generated ID', () => {
  assert.equal(existsSync('infra/ovh.ts'), false);
  assert.match(cluster, /new ovh\.cloudproject\.Project\(\s*'OvhPublicCloudProject'/s);
  assert.match(cluster, /deletionProtection:\s*isProduction/);
  assert.match(cluster, /ovhSubsidiary:\s*'US'/);
  assert.match(
    cluster,
    /plan:\s*\{\s*duration:\s*'P1M',\s*planCode:\s*'project',\s*pricingMode:\s*'default'\s*\}/s
  );
  assert.match(cluster, /\{\s*protect:\s*isProduction\s*\}\s*\)/s);
  assert.doesNotMatch(cluster, /OVH_CLOUD_PROJECT_SERVICE|process\.env/);

  assert.match(cluster, /createClusterNetwork\(\{\s*serviceName:\s*cloudProject\.projectId,/s);
  assert.match(cluster, /CloudProjectId:\s*cloudProject\.projectId/s);
  assert.match(cluster, /ovh\.cloudproject\s*\.getLoadBalancerFlavorsOutput\(/s);
  assert.match(cluster, /ovh\.cloudproject\s*\.getFlavorsOutput\(/s);
  assert.match(cluster, /ovh\.cloudproject\s*\.getImagesOutput\(/s);
  assert.doesNotMatch(
    cluster,
    /createOvhCloudProject|getFlavorId|getImageId|getLoadBalancerFlavorId/
  );
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

void test('CI runs infra checks for VPS IaC changes without dev VPS helper paths', () => {
  assert.match(checksWorkflow, /infra:\n(?:\s+- .*\n)*\s+- 'infra\/\*\*'/);
  assert.match(checksWorkflow, /infra:\n(?:\s+- .*\n)*\s+- 'tsconfig\.json'/);
  for (const [name, command] of [
    ['Typecheck infra', 'pnpm check:infra'],
    ['Test infra', 'pnpm test:infra']
  ]) {
    assert.match(
      checksWorkflow,
      new RegExp(`- name: ${name}\\n\\s+run: ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
  }
  assert.doesNotMatch(checksWorkflow, /scripts\/dev-vps/);
});

void test('production stack orders an annual protected dev VPS-4 with only standard options', () => {
  assert.match(dev, /import \{ isProduction \} from '\.\/utils'/);
  assert.match(dev, /if \(isProduction\)/);
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
});

void test('zero-node stages keep an empty Public Cloud project without cluster resources', () => {
  assert.match(cluster, /const cloudProject = new ovh\.cloudproject\.Project\(/);
  assert.match(cluster, /const network =\s*clusterNodeCount > 0\s*\?\s*createClusterNetwork\(/s);
  assert.match(
    secrets,
    /ApplicationSecret:\s*new sst\.Secret\(\s*'OvhApplicationSecret',\s*process\.env\.OVH_APPLICATION_SECRET\s*\)/s
  );
  assert.match(
    secrets,
    /ConsumerKey:\s*new sst\.Secret\(\s*'OvhConsumerKey',\s*process\.env\.OVH_CONSUMER_KEY\s*\)/s
  );
  assert.doesNotMatch(secrets, /DISABLED_CLUSTER_PLACEHOLDER|k3sTokenPlaceholder/);
  assert.doesNotMatch(secrets, /CloudProjectService|OVH_CLOUD_PROJECT_SERVICE/);
  assert.match(secrets, /K3sToken:\s*new sst\.Secret\(\s*'OvhK3sToken',\s*'Placeholder'\s*\)/s);
});
