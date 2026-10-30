# Updates

Self-hosted over-the-air updates for Expo apps: a Cloudflare Worker that implements the
[Expo Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/), serves manifests
and assets from R2, and signs every manifest and directive with RSA-SHA256. SST deploys it from
`infra/updates.ts` to `https://updates.pandoks.com` (production) and
`https://updates.dev.pandoks.com` (every other stage).

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
      "url": "https://updates.dev.pandoks.com/<slug>",
      "requestHeaders": { "expo-channel-name": "production" },
      "codeSigningCertificate": "./certificate.crt",
      "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
    }
  }
}
```

## Publish and roll back

`publish` runs `expo export`, uploads the assets, and makes the export the latest update. `rollback`
sends clients back to the update embedded in their build until the next `publish`. Both resolve each
platform's runtime version with `expo-updates runtimeversion:resolve`:

```sh
pnpm updates publish dev apps/<app> production ios android
pnpm updates rollback dev apps/<app> production ios android
```

Both need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_DEFAULT_ACCOUNT_ID`, as in `.env.<stage>`.
Production is published only by CI from `main`.

`pnpm --filter @pandoks.com/updates test` runs the Worker's handler against an in-memory bucket and
checks its responses and signatures.
