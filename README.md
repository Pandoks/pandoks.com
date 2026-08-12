# Pandoks 🐼

All things that are related to Pandoks runs on this monorepo. Over time, some of these will branch
off into their own repos, but for now, they are all here.

# Getting Started

Look at [.env.example](/.env.example) and create `.env.<stage>` files. During _development_, you'll
want to use the `.env.<dev-stage>` file where `<dev-stage>` is your local machine's username.
[`sst`](https://sst.dev/) will automatically use the `.env.<dev-stage>` file if you don't specify a
`--stage` flag. During _production_, you'll want to use the `.env.production` file. You'll also have
to specify a `--stage production` flag.

Install the host dependencies yourself before setting up the repository:

- [Git](https://git-scm.com/downloads) and [mise](https://mise.jdx.dev/installing-mise.html)
- [Docker](https://docs.docker.com/get-docker/)
- [OpenSSL](https://www.openssl.org/)
- [Tailscale](https://tailscale.com/download), only for production cluster access

Then run this from the root of the monorepo:

```sh
mise install
eval "$(mise activate "$(basename "$SHELL")")"
cp .env.example ".env.$(whoami)"
# Fill in .env.<stage> and configure the `personal` SSO session in ~/.aws/config.
SST_STAGE="$(whoami)" pnpm install
pnpm sso
```

`mise install` installs only the tools pinned in `mise.toml`. It does not install or configure the
host dependencies above, activate mise in future shells, create environment files, or manage AWS
configuration. After pnpm is available, `pnpm run tools:install` is a convenience alias for rerunning
`mise install --yes`.

> [!NOTE]
> AWS SSO only verifies you for 12 hours, so you'll have to run `pnpm sso` again once in a while

<details>
  <summary>Dependencies</summary>
  <ul>
    <li>
      <b>Via mise</b> (<code>[tools]</code> in <code>mise.toml</code> — exact pins are
      Renovate-bumped via its native mise manager): Node and pnpm (
      <code>packageManager</code> is the authority),
      Go (<code>go.work</code>'s directive rules via GOTOOLCHAIN), kubectl (cluster
      truth stays <code>KUBECTL_VERSION</code> in <code>packages/argocd/Dockerfile</code>; ±1
      minor skew tolerated and drift-checked), helm, k3d, kubeconform, Python 3.14 + uv (uv resolves
      mise's interpreter via
      <code>UV_PYTHON_PREFERENCE=system</code>; uv owns project deps/venvs), and the whole
      lint/format toolchain: shellcheck, shfmt, hadolint, actionlint, golangci-lint, govulncheck;
      plus AWS CLI v2, jq, and GitHub CLI.
    </li>
    <li>
      <a href="https://pnpm.io/">pnpm</a> ≥ v11 — mise installs it; the
      <code>packageManager</code> pin in <code>package.json</code> stays the authority (pnpm
      self-switches to it via <code>manage-package-manager-versions</code> — corepack is removed
      from node 25+)
    </li>
    <li><a href="https://docs.docker.com/get-docker/">Docker</a> >= v20 — install and configure it globally using Docker's platform instructions</li>
    <li><a href="https://www.openssl.org/">openssl</a> >= v3 — used by <code>infra/cloudflare.ts</code> to generate the key and CSR for the 15-year origin TLS certificate; install it through the native package manager</li>
    <li><a href="https://tailscale.com/download">Tailscale</a> — only required for production cluster access (<code>sudo tailscale configure kubeconfig prod-cluster</code>); install it manually if you need prod access</li>
  </ul>

```sh
# the short version:
mise install
```

</details>

## Local Kubernetes Cluster

Although not all of the apps are deployed to Kubernetes, majority of the services are running in a
cluster. To make development easier, we can use a local Kubernetes cluster ([k3d](https://k3d.io/))
to run a copy of the production cluster. This makes it so that majority of the times, we can work
offline or test certain features without having to deploy to a full fledged Kubernetes cluster in
the cloud. _Because we're using k3d, which puts an entire Kubernetes cluster inside of docker
containers, not everything is one to one with the production cluster. ie. networking, registries,
etc_

To setup the local cluster, run this from the root of the monorepo:

```sh
# Quick setup (all-in-one)
pnpm dev:init

# Or step by step:
pnpm cluster k3d deps up             # Start docker compose dependencies
pnpm cluster k3d up                  # Create k3d cluster
pnpm cluster deploy dev --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy dev              # Apply environment overlay
```

To tear down the cluster:

```sh
pnpm dev:destroy
```

See [scripts/cluster/README.md](./scripts/cluster/README.md) for more CLI commands and [k3s/README.md](./k3s/README.md) for cluster architecture details.

## Development

For things that are not deployed to Kubernetes, they are managed by `sst`. To run the development
server, run this from the root of the monorepo:

```sh
pnpm dev # assuming that you are still verified via SSO
```
