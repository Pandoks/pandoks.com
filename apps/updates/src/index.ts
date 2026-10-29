import { Resource } from 'sst/resource';

type Manifest = { id: string };
type Directive = { type: string; parameters?: Record<string, string> };

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
  const latest = await Resource.UpdatesBucket.get(
    `updates/${app}/${channel}/${runtimeVersion}/${platform}.json`
  );
  if (!latest) return new Response('No update for this runtime version', { status: 404 });

  const update = await latest.json<Manifest | Directive>();
  const currentUpdateId = request.headers.get('expo-current-update-id');
  const isRunningLatest =
    'type' in update
      ? currentUpdateId === request.headers.get('expo-embedded-update-id')
      : currentUpdateId === update.id;
  if (isRunningLatest) {
    return respondWithPart({ name: 'directive', body: { type: 'noUpdateAvailable' } });
  }
  if ('type' in update) return respondWithPart({ name: 'directive', body: update });
  return respondWithPart({ name: 'manifest', body: update });
}

async function respondWithPart({ name, body }: { name: string; body: Manifest | Directive }) {
  const json = JSON.stringify(body);
  const signature = await signBody(json);
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
    {
      headers: {
        'expo-protocol-version': '1',
        'expo-sfv-version': '0',
        'cache-control': 'private, max-age=0',
        'content-type': `multipart/mixed; boundary=${boundary}`
      }
    }
  );
}

async function signBody(body: string) {
  const privateKey = await crypto.subtle.importKey(
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
    privateKey,
    new TextEncoder().encode(body)
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
