import { Resource } from 'sst/resource';

type Manifest = { id: string };
type Directive = { type: string; parameters?: Record<string, string> };

const PROTOCOL_HEADERS = {
  'expo-protocol-version': '1',
  'expo-sfv-version': '0',
  'cache-control': 'private, max-age=0'
};

let signingKey: Promise<CryptoKey> | undefined;

export default {
  async fetch(request, _env, context) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/assets/')) return serveAsset({ request, context });
    return serveUpdate({ request, app: pathname.slice(1) });
  }
} satisfies ExportedHandler;

async function serveAsset({ request, context }: { request: Request; context: ExecutionContext }) {
  const cachedResponse = await caches.default.match(request);
  if (cachedResponse) return cachedResponse;

  const asset = await Resource.UpdatesBucket.get(new URL(request.url).pathname.slice(1));
  if (!asset) return new Response('Asset not found', { status: 404 });

  const headers = new Headers({ 'cache-control': 'public, max-age=31536000, immutable' });
  asset.writeHttpMetadata(headers);
  const response = new Response(asset.body, { headers });
  context.waitUntil(caches.default.put(request, response.clone()));
  return response;
}

async function serveUpdate({ request, app }: { request: Request; app: string }) {
  const channel = request.headers.get('expo-channel-name');
  const runtimeVersion = request.headers.get('expo-runtime-version');
  const platform = request.headers.get('expo-platform');
  if (!channel || !runtimeVersion || (platform !== 'ios' && platform !== 'android')) {
    return new Response('Missing channel or runtime version, or unknown platform', { status: 400 });
  }
  const latest = await Resource.UpdatesBucket.get(
    `updates/${app}/${channel}/${runtimeVersion}/${platform}.json`
  );
  if (!latest) return new Response(null, { status: 204, headers: PROTOCOL_HEADERS });

  const update = await latest.json<Manifest | Directive>();
  const currentUpdateId = request.headers.get('expo-current-update-id');
  if ('type' in update) {
    if (currentUpdateId === request.headers.get('expo-embedded-update-id')) {
      return respondWithPart({ name: 'directive', body: { type: 'noUpdateAvailable' } });
    }
    return respondWithPart({ name: 'directive', body: update });
  }
  if (currentUpdateId === update.id) {
    return respondWithPart({ name: 'directive', body: { type: 'noUpdateAvailable' } });
  }
  return respondWithPart({ name: 'manifest', body: update });
}

async function respondWithPart({ name, body }: { name: string; body: Manifest | Directive }) {
  const json = JSON.stringify(body);
  const signature = await signBody({ body: json });
  const boundary = crypto.randomUUID();
  return new Response(
    [
      `--${boundary}`,
      `content-disposition: form-data; name="${name}"`,
      'content-type: application/json; charset=utf-8',
      `expo-signature: sig="${signature}", keyid="main", alg="rsa-v1_5-sha256"`,
      '',
      json,
      `--${boundary}--`,
      ''
    ].join('\r\n'),
    { headers: { ...PROTOCOL_HEADERS, 'content-type': `multipart/mixed; boundary=${boundary}` } }
  );
}

async function signBody({ body }: { body: string }) {
  signingKey ??= crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(
      atob(Resource.UpdatesSigningKey.value.replaceAll(/-----[^-]+-----|\s/g, '')),
      (character) => character.charCodeAt(0)
    ),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await signingKey,
    new TextEncoder().encode(body)
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
