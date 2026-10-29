# Updates

Self-hosted over-the-air updates for Expo apps: a Cloudflare Worker that implements the
[Expo Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/), serves manifests
and assets from R2, and signs every manifest and directive with RSA-SHA256. SST deploys it from
`infra/updates.ts` to `https://updates.pandoks.com` (production) and
`https://updates.dev.pandoks.com` (every other stage).

| Request                                             | Response                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /<slug>` with the expo-updates headers         | Signed `multipart/mixed` manifest, `noUpdateAvailable`, or `rollBackToEmbedded`; `cache-control: private, max-age=0` |
| `GET /assets/<sha256>`                              | Content-addressed asset with `cache-control: public, max-age=31536000, immutable`, cached at the edge                |
| Nothing published for that channel/runtime/platform | `404`                                                                                                                |

R2 (`<prod|dev>-updates`) holds `assets/<base64url sha256>` and one latest
`updates/<slug>/<channel>/<runtime-version>/<ios|android>.json` per platform, which is either a
manifest or a rollback directive.

## Signing key

Expo clients only verify `rsa-v1_5-sha256` with a self-signed certificate that has the
`digitalSignature` key usage and `codeSigning` extended key usage:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=Pandoks Updates' \
  -addext 'keyUsage=critical,digitalSignature' -addext 'extendedKeyUsage=critical,codeSigning' \
  -keyout private-key.pem -out certificate.crt
pnpm sst secret set UpdatesSigningKey --stage <stage> < private-key.pem
```

Keep `private-key.pem` out of git. Every stage needs `UpdatesSigningKey` set, production included,
or its deploys fail.

## App config

Commit `certificate.crt` in the app (`*.pem` is gitignored) and configure `app.json`:

```json
{
  "expo": {
    "slug": "<slug>",
    "runtimeVersion": "1.0.0",
    "updates": {
      "url": "https://updates.pandoks.com/<slug>",
      "requestHeaders": { "expo-channel-name": "production" },
      "codeSigningCertificate": "./certificate.crt",
      "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
    }
  }
}
```

expo-updates sends `expo-platform`, `expo-runtime-version`, `expo-protocol-version: 1`,
`expo-expect-signature`, `expo-current-update-id`, and `expo-embedded-update-id` itself; the
`expo-channel-name` request header picks the channel and sets `Updates.channel`.

## Publish and roll back

`publish` runs `expo export`, uploads the assets, and makes the export the latest update. `rollback`
sends clients back to the update embedded in their build until the next `publish`. The runtime
version must match the app's `runtimeVersion`:

```sh
pnpm updates publish dev apps/<app> production 1.0.0 ios android
pnpm updates rollback dev apps/<app> production 1.0.0 ios android
```

`dev` uploads with `wrangler`, so it needs `CLOUDFLARE_API_TOKEN` or `pnpm exec wrangler login`.

## Local development

Serve local R2 on `http://127.0.0.1:8787` (point a Release build's `updates.url` there), then
publish with `local` instead of `dev`:

```sh
pnpm --filter @pandoks.com/updates dev --ip 127.0.0.1 \
  --var "SST_RESOURCE_UpdatesSigningKey:$(jq -cRs '{ value: . }' private-key.pem)"
pnpm updates publish local apps/<app> production 1.0.0 ios
```

`pnpm --filter @pandoks.com/updates test` runs the same Worker and checks its responses and
signatures.
