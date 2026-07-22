import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const cluster = readFileSync('infra/cluster/cluster.ts', 'utf8');
const clusterConfigModule = readFileSync('infra/cluster/config.ts', 'utf8');
const dns = readFileSync('infra/dns.ts', 'utf8');
const utils = readFileSync('infra/utils.ts', 'utf8');
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
const clusterKustomization = readFileSync('k3s/overlays/cluster/kustomization.yaml', 'utf8');
const exampleApp = readFileSync('apps/example/kube/example.yaml', 'utf8');
const network = readFileSync('infra/cluster/network.ts', 'utf8');
const topologySource = readFileSync('infra/cluster/topology.ts', 'utf8');
const metalLb = readFileSync('k3s/base/core/metallb.yaml', 'utf8');
const loadBalancers = readFileSync('infra/cluster/load-balancers.ts', 'utf8');
const ingress = readFileSync('k3s/bootstrap/core/haproxy-ingress.yaml', 'utf8');
const bootstrap = readFileSync('infra/cluster/providers/bootstrap.ts', 'utf8');
const bootstrapScript = readFileSync('infra/cluster/providers/bootstrap.sh', 'utf8');
const clusterConfigCli = readFileSync('scripts/cluster/config.ts', 'utf8');
const clusterDeploy = readFileSync('scripts/cluster/deploy.sh', 'utf8');
const argocdPlugin = readFileSync('packages/argocd/argocd-plugin.yaml', 'utf8');
const productionArgocd = readFileSync('k3s/overlays/prod/argocd.yaml', 'utf8');
const checksWorkflow = readFileSync('.github/workflows/checks.yaml', 'utf8');
const deployWorkflow = readFileSync('.github/workflows/deploy-infra.yaml', 'utf8');
const dev = readFileSync('infra/dev.ts', 'utf8');
const website = readFileSync('infra/website.ts', 'utf8');
const mise = readFileSync('mise.toml', 'utf8');
const renovate = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
  extends?: string[];
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

  assert.match(utils, /export const isProduction = \$app\.stage === 'production'/);
  assert.match(utils, /export const domain = isProduction \? 'pandoks\.com' : 'dev\.pandoks\.com'/);
  assert.match(utils, /export const EXAMPLE_DOMAIN = `example\.\$\{domain\}`/);
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
  assert.match(cluster, /const args = \{[\s\S]*?protect: isProduction[\s\S]*?\};/);
  assert.match(cluster, /createPublicCloudNodes\(\{ \.\.\.args, pool \}\)/);
  assert.match(cluster, /createDedicatedNodes\(\{ \.\.\.args, pool \}\)/);
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
});

void test('keeps Renovate extraction minimal and OCI Helm chart updates tag-only', () => {
  assert.ok(renovate.extends?.includes(':preserveSemverRanges'));
  assert.ok(renovate.extends?.includes('customManagers:dockerfileVersions'));
  assert.equal(renovate.customManagers?.length, 3);
  assert.deepEqual(
    renovate.customManagers?.find(
      (manager) => manager.description === 'Track annotated HelmChart versions'
    ),
    {
      customType: 'regex',
      description: 'Track annotated HelmChart versions',
      managerFilePatterns: ['/^(?:apps|k3s)/.+\\.ya?ml$/'],
      matchStrings: [
        '# renovate: datasource=(?<datasource>[a-z-]+) depName=(?<depName>\\S+) registryUrl=(?<registryUrl>\\S+)\\s+version:\\s*(?<currentValue>\\S+)'
      ],
      versioningTemplate: 'semver'
    }
  );
  assert.deepEqual(
    renovate.packageRules?.find(
      (rule) =>
        Array.isArray(rule.matchPackageNames) &&
        rule.matchPackageNames.includes('pandoks/charts/**')
    ),
    {
      matchDatasources: ['docker'],
      matchPackageNames: ['pandoks/charts/**'],
      groupName: 'helm charts',
      pinDigests: false
    }
  );
});

void test('keeps local k3d web ingress HTTP-only', () => {
  assert.match(certManager, /name:\s*internal-ca-issuer/);
  assert.doesNotMatch(certManager, /name:\s*cloudflare-origin-tls/);
  assert.doesNotMatch(exampleApp, /^\s*tls:/m);
  assert.doesNotMatch(exampleApp, /cloudflare-origin-tls/);
  assert.equal(existsSync(clusterOriginTlsPatchPath), false);
});

void test('delegates cluster origin TLS issuance and rotation to cert-manager', () => {
  assert.doesNotMatch(secrets, /OriginTls(?:Key|Crt)|OvhOriginTls|HetznerOriginTls/);
  assert.doesNotMatch(cloudflare, /OriginCaCertificate|cluster\.origin|cluster\.openssl|OriginTls/);
  assert.doesNotMatch(credentials, /tls\.(?:crt|key):/);
  assert.doesNotMatch(credentials, /cloudflare-dns-api-token/);

  assert.match(
    clusterOriginTls,
    /kind:\s*Certificate[\s\S]*name:\s*cloudflare-origin-tls[\s\S]*namespace:\s*example/
  );
  assert.match(
    clusterOriginTls,
    /secretName:\s*cloudflare-origin-tls[\s\S]*dnsNames:\s*\n\s*-\s*\$\{ExampleDomain\}[\s\S]*name:\s*letsencrypt-production/
  );
  assert.match(clusterOriginTls, /privateKey:\s*\n\s*rotationPolicy:\s*Always/);

  assert.match(clusterKustomization, /-\s*origin-tls\.yaml/);
  assert.match(
    clusterKustomization,
    /kind:\s*Ingress[\s\S]*namespace:\s*example[\s\S]*path:\s*\/spec\/tls[\s\S]*secretName:\s*cloudflare-origin-tls/
  );
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
  for (const path of [
    'infra/cluster/cluster.openssl.conf',
    'infra/cluster/cluster.origin.dev.csr',
    'infra/cluster/cluster.origin.prod.csr'
  ]) {
    assert.equal(existsSync(path), false, `${path} must be removed`);
  }
});

void test('keeps network, node pools, and MetalLB on one non-overlapping address plan', () => {
  assert.match(network, /new ovh\.CloudNetworkPrivateVrack\(/);
  assert.match(network, /new ovh\.CloudNetworkPrivateVrackSubnet\(/);
  assert.match(network, /new ovh\.CloudGateway\(/);
  assert.doesNotMatch(
    network,
    /ovh\.cloudproject\.(?:NetworkPrivate|NetworkPrivateSubnet|Gateway)/
  );
  assert.match(network, /cidr:\s*config\.networkCidr/);
  assert.match(network, /gatewayIp:\s*config\.gatewayIp/);
  assert.match(network, /allocationPools:\s*\[config\.allocationPool\]/);
  assert.match(network, /dhcpEnabled:\s*true/);
  assert.match(cluster, /buildClusterTopology\(clusterConfig, STAGE_NAME, domain\)/);
  assert.match(metalLb, /\$\{ClusterMetalLbRange\}/);
  assert.match(clusterConfigCli, /ClusterMetalLbRange:\s*region\.metalLbRange/);
  assert.match(clusterDeploy, /scripts\/cluster\/config\.ts"\s*\\\s*\n\s*region/);
  assert.match(clusterDeploy, /Cluster template variables were not fully substituted/);
  assert.match(topologySource, /\.0 OVH\/Neutron, \.1 cloud control planes, \.2 cloud workers/);
  assert.match(topologySource, /\.6 cloud databases, \.7 dedicated databases, \.8-\.255 reserved/);
  assert.match(bootstrapScript, /NETWORK_PREFIX_LENGTH="\$\{NETWORK_CIDR##\*\/\}"/);
  assert.match(bootstrapScript, /\$\{NODE_IP\}\/\$\{NETWORK_PREFIX_LENGTH\}/);
  assert.doesNotMatch(bootstrapScript, /\$\{NODE_IP\}\/24/);
});

void test('uses stable DNS and provisions the private API load balancer only for HA', () => {
  assert.doesNotMatch(utils, /K3S_API_HOSTNAME/);
  assert.match(topologySource, /apiHostname:\s*isWest \? `k3s-api\.\$\{domain\}`/);
  assert.match(loadBalancers, /const \{ config, identity, privateApi, publicIngress \}/);
  assert.match(
    loadBalancers,
    /const api =\s*privateApi\.mode === 'ovh'\s*\?\s*new ovh\.cloudproject\.LoadBalancer/s
  );
  const privateApi = loadBalancers.match(
    /const api = new ovh\.cloudproject\.LoadBalancer\([\s\S]*?\n\s*const ingressNodes/
  )?.[0];
  assert.equal(privateApi, undefined, 'the private API load balancer must not be unconditional');
  assert.equal(
    loadBalancers.match(/'OvhK3sPrivateApiLoadBalancer'/g)?.length,
    1,
    'HA needs at most one private API load balancer'
  );
  assert.match(loadBalancers, /allowedCidrs:\s*\[config\.networkCidr\]/);
  assert.match(
    loadBalancers,
    /const apiTarget = api\?\.vipAddress \?\? privateApi\.nodes\[0\]\?\.privateIp/
  );
  assert.match(
    cluster,
    /new cloudflare\.DnsRecord\([\s\S]*?regionalResourceName\('OvhK3sPrivateApiDnsRecord',[\s\S]*?name:\s*cluster\.identity\.apiHostname[\s\S]*?content:\s*loadBalancers\.apiTarget[\s\S]*?proxied:\s*false/s
  );
  assert.match(cluster, /privateApiDnsRecord\.id\.apply\(\(\) => cluster\.identity\.apiHostname\)/);
  assert.match(cluster, /const args = \{ cluster, nodes, network, apiAddress/);
});

void test('independently scales public ingress load balancers', () => {
  assert.match(loadBalancers, /Array\.from\(\{ length: publicIngress\.loadBalancerCount \}/);
  assert.match(loadBalancers, /members:\s*members\(publicIngress\.nodes,\s*443\)/);
  assert.doesNotMatch(loadBalancers, /protocol:\s*'proxyV2'/);
  assert.match(topologySource, /loadBalancerCount/);
  assert.match(cluster, /export const publicIngress/);
  assert.match(cloudflare, /publicIngress\.mode === 'cloudflare'/);
  assert.match(cloudflare, /new cloudflare\.LoadBalancerMonitor/);
  assert.match(cloudflare, /new cloudflare\.LoadBalancerPool/);
  assert.match(cloudflare, /new cloudflare\.LoadBalancer/);
});

void test('routes each deployed stage through its matching example hostname', () => {
  assert.match(
    dns,
    /new sst\.Linkable\(\s*'ExampleDomain',\s*\{\s*properties:\s*\{\s*value:\s*EXAMPLE_DOMAIN\s*\}\s*\}\s*\)/s
  );
  assert.match(cloudflare, /if \(publicIngress\) \{/);
  assert.doesNotMatch(cloudflare, /!isProduction/);
  assert.equal(clusterOriginTls.match(/\$\{ExampleDomain\}/g)?.length, 1);
  assert.equal(clusterKustomization.match(/\$\{ExampleDomain\}/g)?.length, 1);
  assert.equal(exampleApp.match(/\$\{ExampleDomain\}/g)?.length, 2);
  assert.doesNotMatch(certManager, /example\.pandoks\.com/);
  assert.doesNotMatch(exampleApp, /example\.pandoks\.com/);
});

void test('cluster monitoring matches the disabled default topology', () => {
  const monitoring = readFileSync('k3s/overlays/cluster/prom-etcd-config.yaml', 'utf8');
  assert.doesNotMatch(clusterConfigModule, /\$app|\.\.\/utils/);
  assert.match(clusterConfigModule, /enabled:\s*false/g);
  assert.match(
    cluster,
    /const clusterConfig = isProduction\s*\?\s*PRODUCTION_CLUSTER_CONFIG\s*:\s*NON_PRODUCTION_CLUSTER_CONFIG/
  );
  assert.match(cluster, /for \(const cluster of topology\.regions\)/);
  assert.doesNotMatch(cluster, /shouldProvisionClusterInfrastructure/);
  assert.doesNotMatch(cluster, /process\.env\.OVH_(?:CLOUD|DEDICATED)_/);
  assert.match(monitoring, /^\s*endpoints:\s*\[\]\s*$/m);
  assert.match(argocdPlugin, /--region "\$\{CLUSTER_REGION:-us-west\}"/);
  assert.match(productionArgocd, /name:\s*CLUSTER_REGION[\s\S]*optional:\s*true/);
  assert.match(deployWorkflow, /config\.ts enabled production/);
});

void test('supports direct Cloudflare HTTPS without exposing the Kubernetes API', () => {
  assert.match(ingress, /useHostPort:\s*true/);
  assert.match(ingress, /nodeSelector:\s*\n\s*pandoks\.com\/public-ingress:\s*['"]true['"]/);
  assert.doesNotMatch(ingress, /use-proxy-protocol/);
  assert.match(bootstrap, /DIRECT_INGRESS/);
  assert.match(bootstrapScript, /CLOUDFLARE_IPV4_CIDRS/);
  assert.match(bootstrapScript, /tcp dport \{ 80, 443 \}/);
  assert.doesNotMatch(bootstrapScript, /tcp dport 6443 accept comment "Public/);
});

void test('prefers database workloads on database nodes without breaking single-node clusters', () => {
  const databaseTemplates = [
    'packages/postgres/chart/templates/patroni.yaml',
    'packages/valkey/chart/templates/valkey.yaml',
    'packages/clickhouse/chart/templates/clickhouse.yaml',
    'packages/clickhouse/chart/templates/keeper.yaml'
  ];

  for (const path of databaseTemplates) {
    const template = readFileSync(path, 'utf8');
    assert.match(template, /tolerations:[\s\S]*?key:\s*pandoks\.com\/workload/);
    assert.match(template, /value:\s*database/);
    assert.match(template, /effect:\s*NoSchedule/);
    assert.match(template, /nodeAffinity:/);
    assert.match(template, /preferredDuringSchedulingIgnoredDuringExecution:/);
    assert.match(template, /weight:\s*100/);
    const nodeAffinity = template.match(/nodeAffinity:(?<body>[\s\S]*?)\n\s*podAntiAffinity:/)
      ?.groups?.body;
    assert.ok(nodeAffinity);
    assert.doesNotMatch(nodeAffinity, /requiredDuringSchedulingIgnoredDuringExecution/);
  }
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
  assert.match(cluster, /ovhSubsidiary:\s*OVH_ACCOUNTS\.us\.subsidiary/);
  assert.match(
    cluster,
    /plan:\s*\{\s*duration:\s*'P1M',\s*planCode:\s*'project',\s*pricingMode:\s*'default'\s*\}/s
  );
  assert.match(cluster, /\{\s*protect:\s*isProduction\s*\}\s*\)/s);
  assert.doesNotMatch(cluster, /OVH_CLOUD_PROJECT_SERVICE/);

  assert.match(cluster, /foundations\.us = createFoundation\('us', cloudProject\)/);
  assert.match(cluster, /createClusterNetwork\(foundation, cluster\)/);
  assert.match(cluster, /CloudProjectId:\s*cloudProject\.projectId/s);
  assert.match(loadBalancers, /ovh\.cloudproject\s*\.getLoadBalancerFlavorsOutput\(/s);
  assert.match(publicCloud, /ovh\.cloudproject\s*\.getFlavorsOutput\(/s);
  assert.match(publicCloud, /ovh\.cloudproject\s*\.getImagesOutput\(/s);
  assert.doesNotMatch(
    cluster,
    /createOvhCloudProject|getFlavorId|getImageId|getLoadBalancerFlavorId/
  );
  assert.match(network, /projectId:\s*\$util\.Output<string>/);
  assert.match(loadBalancers, /serviceName:\s*args\.network\.foundation\.projectId/);
  assert.match(publicCloud, /serviceName:\s*args\.network\.foundation\.projectId/);
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
  assert.match(rules, /both currently[\s\S]*set every pool count to zero/i);
  assert.match(rules, /dedicated catalog fields[\s\S]*enabled dedicated pool/i);
  assert.match(
    rules,
    /OVH credentials[\s\S]*Public Cloud project[\s\S]*TypeScript topology contracts/i
  );
  assert.match(rules, /production[\s\S]*protect: isProduction[\s\S]*non-production/i);
  assert.doesNotMatch(rules, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
});

void test('CI runs infra checks for VPS IaC changes without dev VPS helper paths', () => {
  assert.match(checksWorkflow, /infra:\n(?:\s+- .*\n)*\s+- 'infra\/\*\*'/);
  assert.match(checksWorkflow, /infra:\n(?:\s+- .*\n)*\s+- 'scripts\/cluster\/config\.ts'/);
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
  assert.match(cluster, /const enabledAccounts = new Set\(topology\.regions/);
  assert.match(cluster, /for \(const cluster of topology\.regions\)/);
  assert.match(cluster, /const network = createClusterNetwork\(foundation, cluster\)/);
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
  assert.match(secrets, /K3sTokens:\s*\{/);
  assert.match(secrets, /'us-west':\s*new sst\.Secret\('OvhK3sToken', 'Placeholder'\)/);
  assert.match(secrets, /'us-east':\s*new sst\.Secret\('OvhUsEastK3sToken', 'Placeholder'\)/);
});
