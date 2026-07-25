import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

function run(...args: string[]): string {
  return execFileSync(process.execPath, ['scripts/cluster/config.ts', ...args], {
    encoding: 'utf8'
  }).trim();
}

void test('reports every declared cluster for deployment workflow discovery', () => {
  assert.deepEqual(JSON.parse(run('enabled', 'production')), []);
  assert.deepEqual(JSON.parse(run('enabled', 'non-production')), []);
});

void test('rejects unknown stages, clusters, and commands', () => {
  for (const args of [
    ['region', 'production', 'moon'],
    ['region', 'staging', 'us-west'],
    ['unknown', 'production']
  ]) {
    const result = spawnSync(process.execPath, ['scripts/cluster/config.ts', ...args], {
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown (?:cluster|cluster stage|command)/);
  }
});
