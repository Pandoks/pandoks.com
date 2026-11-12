import { Resource } from 'sst/resource';

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
  async fetch(request) {
    const slug = new URL(request.url).pathname.slice(1);
    const platform = request.headers.get('expo-platform');
    const runtimeVersion = request.headers.get('expo-runtime-version');
    if (!runtimeVersion || (platform !== 'ios' && platform !== 'android')) {
      return new Response('Missing runtime version, or unknown platform', { status: 400 });
    }

    const update = await Resource.MobileUpdatesManifests.get<Update>(
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
} satisfies ExportedHandler;

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
