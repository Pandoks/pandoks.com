import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import worker from './index';

const resources: Record<string, unknown> = vi.hoisted(() => ({}));
vi.mock('sst/resource', () => ({ Resource: resources }));

const WORKER_URL = 'https://updates.test';
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
    url: `${WORKER_URL}/assets/${ASSET_HASH}`
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
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const bucketObjects = new Map([
  [`assets/${ASSET_HASH}`, ASSET_BYTES],
  ['updates/test-app/production/1.0.0/ios.json', JSON.stringify(MANIFEST)],
  ['updates/test-app/production/1.0.0/android.json', JSON.stringify(ROLLBACK)]
]);

Object.assign(resources, {
  UpdatesSigningKey: { value: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
  UpdatesBucket: {
    get: (key: string) => {
      const body = bucketObjects.get(key);
      if (body === undefined) return Promise.resolve(null);
      return Promise.resolve({
        body,
        json: () => Promise.resolve(JSON.parse(body) as unknown),
        writeHttpMetadata: () => {}
      });
    }
  }
});
vi.stubGlobal('caches', {
  default: { match: () => Promise.resolve(undefined), put: () => Promise.resolve() }
});

function fetchWorker(path: string, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`${WORKER_URL}${path}`, { headers }), {}, {
    waitUntil: () => {}
  } as unknown as ExecutionContext);
}

function requestUpdate(headers: Record<string, string>) {
  return fetchWorker('/test-app', {
    accept: 'multipart/mixed,application/expo+json,application/json',
    'expo-protocol-version': '1',
    'expo-runtime-version': '1.0.0',
    'expo-channel-name': 'production',
    'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"',
    ...headers
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
  const signatureBytes = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0));
  expect(verify('sha256', new TextEncoder().encode(body), publicKey, signatureBytes)).toBe(true);
  return {
    name: /name="([^"]+)"/.exec(headers['content-disposition'])![1],
    body: JSON.parse(body) as unknown
  };
}

test('serves the latest manifest signed', async () => {
  const response = await requestUpdate({ 'expo-platform': 'ios' });
  expect(response.status).toBe(200);
  expect(response.headers.get('expo-protocol-version')).toBe('1');
  expect(response.headers.get('cache-control')).toBe('private, max-age=0');
  const part = await readSignedPart(response);
  expect(part.name).toBe('manifest');
  expect(part.body).toEqual(MANIFEST);
});

test('serves assets by hash with immutable caching', async () => {
  const response = await fetchWorker(`/assets/${ASSET_HASH}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await response.text()).toBe(ASSET_BYTES);
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

test('tells clients on a runtime version with nothing published that no update is available', async () => {
  const response = await requestUpdate({ 'expo-platform': 'ios', 'expo-runtime-version': '2.0.0' });
  expect(response.status).toBe(204);
  expect(response.headers.get('expo-protocol-version')).toBe('1');
});

test('rejects an unknown platform', async () => {
  const response = await requestUpdate({ 'expo-platform': 'web' });
  expect(response.status).toBe(400);
});
