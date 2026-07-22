import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

function run(...args: string[]): string {
  return execFileSync(process.execPath, ['scripts/cluster/config.ts', ...args], {
    encoding: 'utf8'
  }).trim();
}

void test('returns one regional render source without depending on SST globals', () => {
  assert.deepEqual(JSON.parse(run('region', 'production', 'us-east')), {
    ClusterMetalLbRange: '10.1.5.1-10.1.5.254',
    ClusterRegion: 'us-east',
    ClusterOperatorHostname: 'prod-us-east-cluster'
  });
  assert.deepEqual(JSON.parse(run('region', 'non-production', 'us-west')), {
    ClusterMetalLbRange: '10.0.5.1-10.0.5.254',
    ClusterRegion: 'us-west',
    ClusterOperatorHostname: 'dev-cluster'
  });
});

void test('reports only enabled clusters for deployment workflow discovery', () => {
  assert.deepEqual(JSON.parse(run('enabled', 'production')), []);
});

void test('rejects unknown stages, regions, and commands', () => {
  for (const args of [
    ['region', 'production', 'moon'],
    ['region', 'staging', 'us-west'],
    ['unknown', 'production']
  ]) {
    const result = spawnSync(process.execPath, ['scripts/cluster/config.ts', ...args], {
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown (?:cluster region|cluster stage|command)/);
  }
});
