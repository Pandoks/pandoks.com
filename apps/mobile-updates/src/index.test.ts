import { expect, test, vi } from 'vitest';
import worker from './index';

const updates = new Map(
  ['ios', 'android'].map((platform) => [
    `app/${platform}/fingerprint`,
    {
      id: `${platform}-update`,
      manifest: JSON.stringify({ id: `${platform}-update` }),
      manifestSignature: `${platform}-manifest-signature`,
      noUpdateSignature: `${platform}-no-update-signature`
    }
  ])
);
vi.mock('sst/resource', () => ({
  Resource: {
    MobileUpdatesManifests: { get: (key: string) => Promise.resolve(updates.get(key) ?? null) }
  }
}));

function checkForUpdate(path: string, headers: Record<string, string>) {
  return worker.fetch(new Request(`https://mobile-updates.test${path}`, { headers }));
}

async function readPart(response: Response) {
  const boundary = /boundary=(.+)$/.exec(response.headers.get('content-type')!)![1];
  const [part] = (await response.text()).split(`--${boundary}`).slice(1, -1);
  const [headers, body] = part.slice(2, -2).split('\r\n\r\n');
  return {
    name: /name="([^"]+)"/.exec(headers)![1],
    signature: /sig="([^"]+)"/.exec(headers)![1],
    body
  };
}

test('serves the signed manifest for the phone platform and runtime version', async () => {
  for (const platform of ['ios', 'android']) {
    const response = await checkForUpdate('/app', {
      'expo-platform': platform,
      'expo-runtime-version': 'fingerprint'
    });
    expect(response.headers.get('expo-protocol-version')).toBe('1');
    expect(await readPart(response)).toEqual({
      name: 'manifest',
      signature: `${platform}-manifest-signature`,
      body: JSON.stringify({ id: `${platform}-update` })
    });
  }
});

test('tells a phone already running the update that there is none', async () => {
  const response = await checkForUpdate('/app', {
    'expo-platform': 'ios',
    'expo-runtime-version': 'fingerprint',
    'expo-current-update-id': 'ios-update'
  });
  expect(await readPart(response)).toEqual({
    name: 'directive',
    signature: 'ios-no-update-signature',
    body: '{"type":"noUpdateAvailable"}'
  });
});

test('answers an unpublished app or runtime version with no content', async () => {
  for (const [path, runtimeVersion] of [
    ['/app', 'older-fingerprint'],
    ['/other-app', 'fingerprint']
  ]) {
    const response = await checkForUpdate(path, {
      'expo-platform': 'ios',
      'expo-runtime-version': runtimeVersion
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('expo-protocol-version')).toBe('1');
  }
});

test('rejects a missing runtime version or an unknown platform', async () => {
  for (const headers of [
    { 'expo-platform': 'ios' } as Record<string, string>,
    { 'expo-platform': 'web', 'expo-runtime-version': 'fingerprint' }
  ]) {
    expect((await checkForUpdate('/app', headers)).status).toBe(400);
  }
});
