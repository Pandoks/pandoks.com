import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cluster = readFileSync('infra/cluster/cluster.ts', 'utf8');
const publicCloud = readFileSync('infra/cluster/providers/public-cloud.ts', 'utf8');
const dedicated = readFileSync('infra/cluster/providers/dedicated.ts', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const runbook = readFileSync('infra/cluster/README.md', 'utf8');

test('passes exact per-node protection through both provider adapters', () => {
  assert.match(cluster, /OVH_UNPROTECTED_NODE_LOGICAL_NAME/);
  assert.match(cluster, /protect: isClusterNodeProtected\(/);
  assert.equal(publicCloud.match(/protect: args\.protect/g)?.length, 1);
  assert.equal(dedicated.match(/protect: args\.protect/g)?.length, 2);
});

test('declares the non-secret targeted unprotect control', () => {
  assert.match(envExample, /^OVH_UNPROTECTED_NODE_LOGICAL_NAME=$/m);
});

test('runbook maps all pools and derives only the highest-index target', () => {
  for (const mapping of [
    [
      'cloud-control-plane',
      'OVH_CLOUD_CONTROL_PLANE_COUNT',
      'prod-ovh-control-plane-server-',
      'OvhControlPlaneServer'
    ],
    ['cloud-workers', 'OVH_CLOUD_WORKER_COUNT', 'prod-ovh-worker-server-', 'OvhWorkerServer'],
    [
      'dedicated-control-plane',
      'OVH_DEDICATED_CONTROL_PLANE_COUNT',
      'prod-ovh-dedicated-control-plane-server-',
      'OvhDedicatedControlPlaneServer'
    ],
    [
      'dedicated-workers',
      'OVH_DEDICATED_WORKER_COUNT',
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

test('runbook documents the exact two-step unprotect transition', () => {
  assert.match(runbook, /OVH_UNPROTECTED_NODE_LOGICAL_NAME=OvhDedicatedControlPlaneServer2/);
  assert.match(runbook, /Keep all four pool counts unchanged/);
  assert.match(runbook, /Reduce only the selected pool count by exactly one/);
  assert.match(runbook, /does not match a currently declared highest-index node/);
  assert.match(runbook, /Clear `OVH_UNPROTECTED_NODE_LOGICAL_NAME`/);
});

test('runbook orders control-plane etcd removal commands safely', () => {
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
