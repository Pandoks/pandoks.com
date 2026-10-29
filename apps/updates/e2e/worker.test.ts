import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, verify, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';

const WORKER_DIR = join(import.meta.dirname, '..');
const STATE_DIR = mkdtempSync(join(tmpdir(), 'updates-test-'));
const ASSET_BYTES = 'console.log("update")';
const ASSET_HASH = createHash('sha256').update(ASSET_BYTES).digest('base64url');
const MANIFEST = {
  id: '0f8b9e4c-6a0e-4f6b-9a51-0d2c8c4e7b11',
  createdAt: '2026-10-29T00:00:00.000Z',
  runtimeVersion: '1.0.0',
  launchAsset: {
    hash: ASSET_HASH,
    key: 'bundle',
    contentType: 'application/javascript',
    url: `/assets/${ASSET_HASH}`
  },
  assets: [],
  metadata: {},
  extra: {}
};
const ROLLBACK = {
  type: 'rollBackToEmbedded',
  parameters: { commitTime: '2026-10-29T00:00:00.000Z' }
};
const EMBEDDED_UPDATE_ID = '5a1d6b0e-2c3f-4e7a-8b9c-1d2e3f4a5b6c';

let workerUrl: string;
let certificate: X509Certificate;
let worker: ReturnType<typeof spawn>;

async function putObject({
  key,
  file,
  contentType
}: {
  key: string;
  file: string;
  contentType: string;
}) {
  await promisify(execFile)(
    'pnpm',
    [
      'exec',
      'wrangler',
      'r2',
      'object',
      'put',
      `dev-updates/${key}`,
      '--file',
      file,
      '--content-type',
      contentType,
      '--local',
      '--persist-to',
      STATE_DIR
    ],
    { cwd: WORKER_DIR }
  );
}

async function getFreePort() {
  const server = createServer().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  server.close();
  return port;
}

function requestUpdate(headers: Record<string, string>) {
  return fetch(`${workerUrl}/test-app`, {
    headers: {
      accept: 'multipart/mixed,application/expo+json,application/json',
      'expo-protocol-version': '1',
      'expo-runtime-version': '1.0.0',
      'expo-channel-name': 'production',
      'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      ...headers
    }
  });
}

async function readSignedPart(response: Response) {
  const boundary = /boundary=(.+)$/.exec(response.headers.get('content-type')!)![1];
  const parts = (await response.text()).split(`--${boundary}`).slice(1, -1);
  expect(parts).toHaveLength(1);
  const [rawHeaders, body] = parts[0].slice(2, -2).split('\r\n\r\n');
  const headers = Object.fromEntries(
    rawHeaders.split('\r\n').map((line) => line.split(/: (.*)/s, 2) as [string, string])
  );
  const signature = /sig="([^"]+)"/.exec(headers['expo-signature'])![1];
  expect(
    verify('sha256', Buffer.from(body), certificate.publicKey, Buffer.from(signature, 'base64'))
  ).toBe(true);
  return {
    name: /name="([^"]+)"/.exec(headers['content-disposition'])![1],
    body: JSON.parse(body) as unknown
  };
}

beforeAll(async () => {
  const keyFile = join(STATE_DIR, 'private-key.pem');
  const certificateFile = join(STATE_DIR, 'certificate.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyFile,
    '-out',
    certificateFile,
    '-days',
    '1',
    '-subj',
    '/CN=test'
  ]);
  certificate = new X509Certificate(readFileSync(certificateFile));

  writeFileSync(join(STATE_DIR, 'asset'), ASSET_BYTES);
  writeFileSync(join(STATE_DIR, 'manifest.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(STATE_DIR, 'rollback.json'), JSON.stringify(ROLLBACK));
  // NOTE: local R2 is one SQLite database, so concurrent writes fail
  await putObject({
    key: `assets/${ASSET_HASH}`,
    file: join(STATE_DIR, 'asset'),
    contentType: 'application/javascript'
  });
  await putObject({
    key: 'updates/test-app/production/1.0.0/ios.json',
    file: join(STATE_DIR, 'manifest.json'),
    contentType: 'application/json'
  });
  await putObject({
    key: 'updates/test-app/production/1.0.0/android.json',
    file: join(STATE_DIR, 'rollback.json'),
    contentType: 'application/json'
  });

  const port = await getFreePort();
  const signingKey = JSON.stringify({ value: readFileSync(keyFile, 'utf8') });
  worker = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      STATE_DIR,
      '--show-interactive-dev-session=false',
      '--var',
      `SST_RESOURCE_UpdatesSigningKey:${signingKey}`
    ],
    { cwd: WORKER_DIR, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  await new Promise<void>((resolve) => {
    worker.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Ready on')) resolve();
    });
  });
  workerUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(() => {
  worker.kill();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

test('serves the latest manifest signed, with absolute asset URLs', async () => {
  const response = await requestUpdate({ 'expo-platform': 'ios' });
  expect(response.status).toBe(200);
  expect(response.headers.get('expo-protocol-version')).toBe('1');
  expect(response.headers.get('cache-control')).toBe('private, max-age=0');
  const part = await readSignedPart(response);
  expect(part.name).toBe('manifest');
  expect(part.body).toEqual({
    ...MANIFEST,
    launchAsset: { ...MANIFEST.launchAsset, url: `${workerUrl}/assets/${ASSET_HASH}` }
  });
});

test('serves assets matching their manifest hash with immutable caching', async () => {
  const response = await fetch(`${workerUrl}/assets/${ASSET_HASH}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/javascript');
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  const body = Buffer.from(await response.arrayBuffer());
  expect(createHash('sha256').update(body).digest('base64url')).toBe(ASSET_HASH);
});

test('tells a client already running the latest manifest that no update is available', async () => {
  const response = await requestUpdate({
    'expo-platform': 'ios',
    'expo-current-update-id': MANIFEST.id
  });
  expect(await readSignedPart(response)).toEqual({
    name: 'directive',
    body: { type: 'noUpdateAvailable' }
  });
});

test('serves a signed rollback directive to clients running a downloaded update', async () => {
  const response = await requestUpdate({
    'expo-platform': 'android',
    'expo-current-update-id': MANIFEST.id,
    'expo-embedded-update-id': EMBEDDED_UPDATE_ID
  });
  expect(await readSignedPart(response)).toEqual({ name: 'directive', body: ROLLBACK });
});

test('tells a client already on its embedded update that no update is available after a rollback', async () => {
  const response = await requestUpdate({
    'expo-platform': 'android',
    'expo-current-update-id': EMBEDDED_UPDATE_ID,
    'expo-embedded-update-id': EMBEDDED_UPDATE_ID
  });
  expect(await readSignedPart(response)).toEqual({
    name: 'directive',
    body: { type: 'noUpdateAvailable' }
  });
});

test('returns 404 for a runtime version with nothing published', async () => {
  const response = await requestUpdate({ 'expo-platform': 'ios', 'expo-runtime-version': '2.0.0' });
  expect(response.status).toBe(404);
});
