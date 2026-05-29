# Pandoks 🐼

All things that are related to Pandoks runs on this monorepo. Over time, some of these will branch
off into their own repos, but for now, they are all here.

# Getting Started

Look at [.env.example](/.env.example) and create `.env.<stage>` files. During _development_, you'll
want to use the `.env.<dev-stage>` file where `<dev-stage>` is your local machine's username.
[`sst`](https://sst.dev/) will automatically use the `.env.<dev-stage>` file if you don't specify a
`--stage` flag. During _production_, you'll want to use the `.env.production` file. You'll also have
to specify a `--stage production` flag.

Once you have created your `.env` files, run this from the root of the monorepo to set it up for
development:

```sh
pnpm setup all   # one-time: install every dependency listed below (see script for per-OS details)
pnpm install
pnpm sso
```

`pnpm setup` supports macOS (via Homebrew), Ubuntu/Debian (apt), and Arch (pacman). It assumes only
that `git` is installed and the repo is cloned. It has three subcommands: `all` (the default —
installs everything), `check` (inventory installed versions and flag drift from the pins), and
`help`.

> [!NOTE]
> AWS SSO only verifies you for 12 hours, so you'll have to run `pnpm sso` again once in a while

<details>
  <summary>Dependencies</summary>
  <p>All installed by <code>pnpm setup all</code>. Listed here for reference / manual installs.</p>
  <ul>
    <li>
      <a href="https://nodejs.org/en/">Node.js</a> >= v24 (installed via <a href="https://github.com/nvm-sh/nvm">nvm</a>, version pinned in <code>.nvmrc</code>)
    </li>
    <li><a href="https://pnpm.io/">pnpm</a> >= v11 (activated via <code>corepack</code> from <code>package.json</code>)</li>
    <li><a href="https://docs.astral.sh/uv/">uv</a> — Python version + project manager (Python toolchain is installed on demand via <code>uv python install</code>)</li>
    <li><a href="https://go.dev/">Go</a> >= v1.25</li>
    <li><a href="https://docs.docker.com/get-docker/">Docker</a> >= v20</li>
    <li><a href="https://kubernetes.io/docs/tasks/tools/">kubectl</a> v1.36 (matches the prod cluster in <code>packages/argocd/Dockerfile</code>; kubectl supports ±1 minor against the cluster)</li>
    <li><a href="https://k3d.io/">k3d</a> >= v5.8</li>
    <li><a href="https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html">awscli</a> >= v2.13 (v2 only; v1 is not supported)</li>
    <li><a href="https://helm.sh/docs/intro/install/">helm</a> >= v3.19</li>
    <li><a href="https://jqlang.github.io/jq/">jq</a> >= v1.7</li>
    <li><a href="https://www.openssl.org/">openssl</a> >= v3 (used by <code>infra/cloudflare.ts</code> for the 15-year origin TLS cert)</li>
    <li><a href="https://httpd.apache.org/docs/current/programs/htpasswd.html">htpasswd</a> — bcrypt hasher used by the <code>${VAR | bcrypt}</code> template filter in <code>pnpm cluster deploy</code> (ships with macOS; from <code>apache2-utils</code> on Debian, <code>apache</code> on Arch)</li>
    <li><a href="https://github.com/yannh/kubeconform">kubeconform</a> — Kubernetes manifest validator (installed via <code>go install</code>)</li>
    <li>Lint / format / security toolchain, all run by <code>pnpm lint</code> / <code>pnpm format</code>: <a href="https://www.shellcheck.net/">shellcheck</a>, <a href="https://github.com/mvdan/sh">shfmt</a>, <a href="https://github.com/hadolint/hadolint">hadolint</a> (Dockerfiles), <a href="https://github.com/rhysd/actionlint">actionlint</a> (GitHub Actions), <a href="https://golangci-lint.run/">golangci-lint</a>, <a href="https://go.dev/security/vuln/">govulncheck</a>. On Linux the latter four come via GitHub releases / <code>go install</code> (not in apt/pacman); on macOS they are Homebrew formulae.</li>
    <li><a href="https://tailscale.com/download">Tailscale</a> — only required for production cluster access (<code>sudo tailscale configure kubeconfig prod-cluster</code>); not installed by <code>pnpm setup</code>, install manually if you need prod access</li>
  </ul>

```sh
# macOS (htpasswd ships with the OS):
brew install go kubectl k3d awscli helm jq openssl@3 uv tailscale
```

</details>

<details>
  <summary>Code Quality &amp; Formatting</summary>
  <p>
    Required to run <code>pnpm lint</code> or <code>pnpm format</code> locally. Installed by
    <code>pnpm setup all</code> (or <code>pnpm setup quality</code> for just these). Not needed for
    runtime or builds — CI installs these automatically.
  </p>
  <ul>
    <li><a href="https://golangci-lint.run/">golangci-lint</a> — Go linter &amp; formatter</li>
    <li><a href="https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck">govulncheck</a> — Go vulnerability scanner (run by <code>pnpm lint go</code>)</li>
    <li><a href="https://www.shellcheck.net/">shellcheck</a> — shell script linter</li>
    <li><a href="https://github.com/mvdan/sh">shfmt</a> — shell formatter (reads <code>.editorconfig</code>)</li>
    <li><a href="https://github.com/hadolint/hadolint">hadolint</a> — Dockerfile linter</li>
    <li><a href="https://github.com/rhysd/actionlint">actionlint</a> — GitHub Actions workflow linter</li>
    <li><a href="https://github.com/yannh/kubeconform">kubeconform</a> — Kubernetes schema validator</li>
  </ul>

```sh
brew install golangci-lint shellcheck shfmt hadolint actionlint kubeconform
go install golang.org/x/vuln/cmd/govulncheck@latest
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
