export interface Env {
  MOBILE_UPDATES_MANIFESTS: KVNamespace;
}

// The signed parts scripts/mobile-updates publishes for one app, platform, and runtime version
type Update = {
  id: string;
  manifest: string;
  manifestSignature: string;
  noUpdateSignature: string;
};

const NO_UPDATE = JSON.stringify({ type: 'noUpdateAvailable' });
const PROTOCOL_HEADERS = {
  'expo-protocol-version': '1',
  'expo-sfv-version': '0',
  'cache-control': 'private, max-age=0'
};

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
    }
    const slug = new URL(request.url).pathname.slice(1);
    if (!/^[A-Za-z0-9._-]+$/.test(slug)) {
      return new Response('Not Found', { status: 404 });
    }
    const platform = request.headers.get('expo-platform');
    const runtimeVersion = request.headers.get('expo-runtime-version');
    if (!runtimeVersion || (platform !== 'ios' && platform !== 'android')) {
      return new Response('Missing runtime version, or unknown platform', { status: 400 });
    }

    const update = await env.MOBILE_UPDATES_MANIFESTS.get<Update>(
      `${slug}/${platform}/${runtimeVersion}`,
      'json'
    );
    if (!update) return new Response(null, { status: 204, headers: PROTOCOL_HEADERS });
    if (request.headers.get('expo-current-update-id') === update.id) {
      return respondWithPart({
        name: 'directive',
        body: NO_UPDATE,
        signature: update.noUpdateSignature
      });
    }
    return respondWithPart({
      name: 'manifest',
      body: update.manifest,
      signature: update.manifestSignature
    });
  }
} satisfies ExportedHandler<Env>;

function respondWithPart({
  name,
  body,
  signature
}: {
  name: string;
  body: string;
  signature: string;
}) {
  const boundary = crypto.randomUUID();
  return new Response(
    [
      `--${boundary}`,
      `content-disposition: form-data; name="${name}"`,
      'content-type: application/json; charset=utf-8',
      `expo-signature: sig="${signature}", keyid="main", alg="rsa-v1_5-sha256"`,
      '',
      body,
      `--${boundary}--`,
      ''
    ].join('\r\n'),
    { headers: { ...PROTOCOL_HEADERS, 'content-type': `multipart/mixed; boundary=${boundary}` } }
  );
}
