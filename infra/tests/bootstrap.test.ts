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
  assert.match(bootstrapScript, /hostname:\s*"\$\{STAGE_NAME\}-cluster"/);

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
