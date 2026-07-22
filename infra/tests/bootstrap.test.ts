import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const bootstrapPath = 'infra/cluster/providers/bootstrap.ts';
const bootstrapScriptPath = 'infra/cluster/providers/bootstrap.sh';

void test('uses one shared shell bootstrap for public cloud and dedicated servers', () => {
  assert.ok(existsSync(bootstrapPath), `${bootstrapPath} must exist`);
  assert.ok(existsSync(bootstrapScriptPath), `${bootstrapScriptPath} must exist`);

  const bootstrap = readFileSync(bootstrapPath, 'utf8');
  const bootstrapScript = readFileSync(bootstrapScriptPath, 'utf8');
  const publicCloud = readFileSync('infra/cluster/providers/public-cloud.ts', 'utf8');
  const dedicated = readFileSync('infra/cluster/providers/dedicated.ts', 'utf8');

  assert.match(bootstrapScript, /^#!\/bin\/sh\n/);
  assert.match(bootstrapScript, /^# PANDOKS_BOOTSTRAP_ENVIRONMENT$/m);
  assert.match(bootstrap, /function renderBootstrapScript\(/);
  assert.match(bootstrap, /const script = \$resolve\(/);
  assert.match(bootstrap, /return script/);
  assert.doesNotMatch(bootstrap, /const payload|=>\s*\$resolve\(/);
  assert.doesNotMatch(bootstrap, /secrets\.Stage|KUBERNETES_TAILSCALE_HOSTNAME/);
  assert.doesNotMatch(bootstrap, /cloudInit|dedicatedPostInstall|systemdUnit/);

  assert.match(publicCloud, /userData:\s*bootstrap/);
  assert.match(
    dedicated,
    /postInstallationScript:\s*bootstrap\.apply\(\(script\) =>\s*Buffer\.from\(script\)\.toString\('base64'\)\s*\)/s
  );
  assert.match(bootstrapScript, /hostname:\s*"\$\{CLUSTER_OPERATOR_HOSTNAME\}"/);

  assert.equal(existsSync('infra/cluster/bootstrap.ts'), false);
  assert.equal(existsSync('infra/cluster/bootstrap.sh'), false);
  assert.equal(existsSync('infra/cluster/bootstrap-render.ts'), false);
  assert.equal(existsSync('infra/cluster/cloud-config.yaml'), false);
});

void test('injects every per-node value as a safely quoted exported variable', () => {
  assert.ok(existsSync(bootstrapPath), `${bootstrapPath} must exist`);
  const bootstrap = readFileSync(bootstrapPath, 'utf8');

  assert.doesNotMatch(bootstrap, /type BootstrapEnvironment|renderBootstrapEnvironment/);
  assert.match(
    bootstrap,
    /function renderBootstrapScript\(\s*environment: Readonly<Record<string, string>>\s*\)/
  );
  assert.match(
    bootstrap,
    /\.map\(\(\[name, value\]\) => `export \$\{name\}=\$\{shellQuote\(value\)\}`\)/
  );
  assert.match(bootstrap, /value\.replaceAll\("'", `'"'"'`\)/);
  assert.match(
    bootstrap,
    /bootstrapScript\.replace\(\s*BOOTSTRAP_ENVIRONMENT_MARKER,\s*Object\.entries\(environment\)[\s\S]*?\.join\('\\n'\)\s*\)/
  );
});

void test('registers workload and public-ingress placement metadata with k3s', () => {
  const bootstrap = readFileSync(bootstrapPath, 'utf8');
  const bootstrapScript = readFileSync(bootstrapScriptPath, 'utf8');

  assert.match(bootstrap, /WORKLOAD:\s*args\.node\.pool\.workload/);
  assert.match(bootstrap, /PUBLIC_INGRESS:\s*String\(args\.node\.pool\.publicIngress\)/);
  assert.match(bootstrapScript, /--node-label="pandoks\.com\/workload=\$\{WORKLOAD\}"/);
  assert.match(bootstrapScript, /--node-label="pandoks\.com\/public-ingress=\$\{PUBLIC_INGRESS\}"/);
  assert.match(bootstrapScript, /--node-taint="pandoks\.com\/workload=database:NoSchedule"/);
});

void test('injects independent regional k3s identity and critical server networks', () => {
  const bootstrap = readFileSync(bootstrapPath, 'utf8');
  const bootstrapScript = readFileSync(bootstrapScriptPath, 'utf8');

  for (const value of [
    'CLUSTER_REGION',
    'CLUSTER_OPERATOR_HOSTNAME',
    'CLUSTER_POD_CIDR',
    'CLUSTER_SERVICE_CIDR',
    'ETCD_BACKUP_FOLDER',
    'VRACK_VLAN_ID'
  ]) {
    assert.match(bootstrap, new RegExp(`${value}:`));
  }
  assert.equal(bootstrapScript.match(/--cluster-cidr="\$\{CLUSTER_POD_CIDR\}"/g)?.length, 2);
  assert.equal(bootstrapScript.match(/--service-cidr="\$\{CLUSTER_SERVICE_CIDR\}"/g)?.length, 2);
  assert.equal(bootstrapScript.match(/--etcd-s3-folder="\$\{ETCD_BACKUP_FOLDER\}"/g)?.length, 2);
  assert.match(
    bootstrapScript,
    /kubectl create configmap pandoks-cluster[\s\S]*--from-literal=region="\$\{CLUSTER_REGION\}"/
  );
});

void test('keeps VLAN 0 untagged and configures future dedicated VLAN interfaces', () => {
  const bootstrapScript = readFileSync(bootstrapScriptPath, 'utf8');
  assert.match(bootstrapScript, /if \[ "\$\{VRACK_VLAN_ID\}" = "0" \]; then/);
  assert.match(bootstrapScript, /set-name: vrack0/);
  assert.match(bootstrapScript, /vlans:[\s\S]*vrack0\.\$\{VRACK_VLAN_ID\}:/);
  assert.match(bootstrapScript, /id: \$\{VRACK_VLAN_ID\}/);
  assert.match(bootstrapScript, /link: vrack\n/);
  assert.doesNotMatch(bootstrapScript, /link: vrack0/);
  assert.match(bootstrapScript, /VRACK_INTERFACE="vrack0\.\$\{VRACK_VLAN_ID\}"/);
});
