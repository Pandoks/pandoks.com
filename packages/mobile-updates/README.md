# Mobile updates

Self-hosted over-the-air updates for Expo apps: a Go server that implements the
[Expo Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/) for the update
baked into its image, and a Helm chart that runs it for one app. Every manifest and directive is
signed with RSA-SHA256.

Each app gets its own image, built from this `Dockerfile` with `APP` set to its directory under
`apps/`. The build runs `expo export` for iOS and Android and resolves each platform's runtime
version and the app's public config twice: once as is, for production builds, and once with
`MOBILE_UPDATES_ENVIRONMENT=dev`, the variable an app's config reads to point dev builds at the dev
host, which changes their native fingerprint. The server answers:

- `GET /` with `expo-platform` and `expo-runtime-version`: the signed manifest, a signed
  `noUpdateAvailable` directive when `expo-current-update-id` is already that update, `204` when the
  runtime version is neither of the image's, and `400` without a runtime version or for an unknown
  platform.
- `GET /assets/<sha256>`: the update's files.

Every build is a new update with its own ID and creation time, even of old code, since expo-updates
launches the newest update it has.

```sh
docker build -f packages/mobile-updates/Dockerfile --build-arg APP=<app> \
  --build-arg CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -t <app>-mobile-updates .
```

## Signing key

Expo clients only verify `rsa-v1_5-sha256` with a self-signed certificate that has the
`digitalSignature` key usage and `codeSigning` extended key usage:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=Pandoks Mobile Updates' \
  -addext 'keyUsage=critical,digitalSignature' -addext 'extendedKeyUsage=critical,codeSigning' \
  -keyout private-key.pem -out certificate.crt
pnpm sst secret set MobileUpdatesSigningKey --stage <stage> < private-key.pem
```

Keep `private-key.pem` out of git. Every stage needs `MobileUpdatesSigningKey` set, production
included, or its deploys fail.

## Usage

Run the chart from the app's `kube/` with the [HelmChart](https://docs.k3s.io/add-ons/helm) kind. It
serves the app at `https://${MobileUpdatesDomain}/<slug>`: `mobile-updates.pandoks.com` in
production and `mobile-updates-dev.pandoks.com` in every other stage.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mobile-updates-<slug>-signing-key
  namespace: <namespace>
type: Opaque
data:
  private-key.pem: ${MobileUpdatesSigningKey | base64}

---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: <namespace>-mobile-updates-<slug>
  namespace: kube-system
spec:
  chart: oci://${ImageRegistry}/charts/mobile-updates
  version: 0.1.0
  targetNamespace: &namespace <namespace>
  createNamespace: true
  failurePolicy: abort
  plainHTTP: ${IsLocal}
  set:
    name: <slug>
    namespace: *namespace
    image: ghcr.io/pandoks/<app>-mobile-updates:latest@sha256:<digest>
    host: ${MobileUpdatesDomain}
    signingKey.secret: mobile-updates-<slug>-signing-key
```

The namespace also needs the `cloudflare-origin-tls` secret, like
[apps/example/kube/credentials.yaml](/apps/example/kube/credentials.yaml). Renovate bumps the image
digest after `main` builds a new one, so merging that PR releases the update. To roll back, revert
the change on `main` and merge the next bump: reverting a bump only stops phones that haven't
downloaded that update yet. Keep the app's `kube/` out of the image's build filter, or each bump
rebuilds the image.

In the app, commit the certificate (`*.pem` is gitignored), list `/android` and `/ios` in its own
`.gitignore` so the fingerprint skips generated native code, and point `updates.url` at the app's
URL:

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

`pnpm --filter @pandoks.com/mobile-updates test` runs the server against a fake export and checks
its responses and signatures.
