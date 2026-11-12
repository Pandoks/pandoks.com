# Mobile updates

Self-hosted over-the-air updates for every Expo app here, over the
[Expo Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/). SST deploys it
from `infra/mobile-updates.ts`; production uses the hosts below, and every other stage the same
hosts with `-dev` before `.pandoks.com`.

```mermaid
flowchart LR
  phone[Phone] -- "GET /&lt;slug&gt; + platform and runtime version headers" --> worker["Worker<br/>mobile-updates.pandoks.com"]
  worker -- "&lt;slug&gt;/&lt;platform&gt;/&lt;runtime version&gt;" --> kv[(KV<br/>MobileUpdatesManifests)]
  phone -- "GET /&lt;sha256&gt;" --> cache["Edge cache<br/>mobile-updates-assets.pandoks.com"]
  cache -- miss --> r2[(R2<br/>&lt;prod|dev&gt;-mobile-updates)]
```

The Worker answers a check with the signed manifest for the phone's app, platform, and runtime
version, a signed `noUpdateAvailable` directive when `expo-current-update-id` is already that
update, `204` when nothing is published for it, and `400` without a runtime version or for an
unknown platform. It holds no key: `publish` signs everything. Update files live in R2 under their
SHA-256 and are never deleted, since phones can fetch any update's files at any time.

## Signing key

Generate the key and its certificate outside the repo with Expo's generator, from any app with
`expo-updates`:

```sh
pnpm --dir apps/<app> exec expo-updates codesigning:generate \
  --certificate-common-name 'Pandoks Mobile Updates' --certificate-validity-duration-years 10 \
  --key-output-directory ~/mobile-updates-keys --certificate-output-directory ~/mobile-updates-keys
pnpm sst secret set MobileUpdatesSigningKey --stage <stage> < ~/mobile-updates-keys/private-key.pem
```

Keep `private-key.pem` out of git and backed up: installed apps only trust the certificate they
shipped with. Every stage needs `MobileUpdatesSigningKey` set, production included, or its deploys
fail. `publish` signs with the value from the stage's last deploy, so deploy after changing it.

## App config

Commit `certificate.pem` in the app as `certificate.crt` (`*.pem` is gitignored), list `/android`
and `/ios` in its own `.gitignore` so the fingerprint skips generated native code, and point
`updates.url` at its slug:

```ts
export default ({ config }: ConfigContext) => ({
  ...config,
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: `https://${process.env.MOBILE_UPDATES_ENVIRONMENT === 'dev' ? 'mobile-updates-dev' : 'mobile-updates'}.pandoks.com/${config.slug}`,
    codeSigningCertificate: './certificate.crt',
    codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' }
  }
});
```

Build with `MOBILE_UPDATES_ENVIRONMENT=dev` for the dev stages; it changes the build's runtime
version, so dev and production builds never get each other's updates.

## Publish

`publish` runs `expo export`, checks the signing key against the app's certificate, uploads the
files to R2 in parallel, then signs and writes each platform's manifest to KV. Every publish is a
new update, so to roll back, revert the change on `main`; production publishes only from
`deploy-infra.yaml` on `main`. Other stages:

```sh
pnpm sst shell --stage <stage> -- pnpm mobile-updates publish apps/<app>
```

`pnpm --filter @pandoks.com/mobile-updates test` runs the Worker against an in-memory KV.
