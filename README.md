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
./scripts/bootstrap/main.sh all --global # recommended: includes the required global CLIs
eval "$(mise activate "$(basename "$SHELL")")"
pnpm install
pnpm sso
```

`aws-cli` and `jq` are used by `pnpm sso` and the cluster scripts, so fresh machines should use
`--global`. Omit the flag only if you already install and manage the global tools yourself; the
custom table is then ignored. Add `--reload` to either form to restart an interactive shell
immediately instead of running the `eval` command separately:

```sh
./scripts/bootstrap/main.sh all --global --reload
```

The bootstrap script supports macOS (via Homebrew), Ubuntu/Debian (apt), and Arch (pacman). It
assumes only that `git` is installed and the repo is cloned. It has three subcommands: `all` (the
default — installs `[tools]` with repository-local mise activation), `check` (inventory installed
versions and flag drift from the declarations), and `help`. `all --global` additionally installs
`[_.global_tools]` into the current user's global mise config without replacing unrelated global
settings. After the first run, the equivalent `pnpm bootstrap` commands are available.

> [!NOTE]
> AWS SSO only verifies you for 12 hours, so you'll have to run `pnpm sso` again once in a while

<details>
  <summary>Dependencies</summary>
  <p>
    All installed by <code>./scripts/bootstrap/main.sh all</code>: it bootstraps
    <a href="https://mise.jdx.dev/">mise</a> (wiring the shell rc with
    <code>mise activate</code> so mise always wins PATH resolution), runs
    <code>mise bootstrap</code> (system packages through apt, Homebrew, or pacman; shell activation;
    and every version-shaped tool declared in <code>mise.toml</code>), then upgrades the declared
    system packages. With <code>--global</code>, it also installs the custom
    <code>[_.global_tools]</code> table into <code>~/.config/mise/config.toml</code> for the current
    user. Without the flag, that table is ignored. The bootstrap script also writes the AWS config.
    Listed here for reference / manual installs.
  </p>
  <ul>
    <li>
      <b>Via mise</b> (<code>[tools]</code> in <code>mise.toml</code> — exact pins are
      Renovate-bumped via its native mise manager): Node, pnpm (bootstrap;
      <code>packageManager</code> is the authority),
      Go (bootstrap; <code>go.work</code>'s directive rules via GOTOOLCHAIN), kubectl (cluster
      truth stays <code>KUBECTL_VERSION</code> in <code>packages/argocd/Dockerfile</code>; ±1
      minor skew tolerated and drift-checked), helm, k3d, kubeconform, Python 3.14 + uv (uv resolves
      mise's interpreter via
      <code>UV_PYTHON_PREFERENCE=system</code>; uv owns project deps/venvs), and the whole
      lint/format toolchain: shellcheck, shfmt, hadolint, actionlint, golangci-lint, govulncheck.
    </li>
    <li>
      <b>Via global mise</b> (<code>[_.global_tools]</code>, installed only with
      <code>--global</code>): awscli v2, jq, Claude Code, Codex, and GitHub CLI.
    </li>
    <li>
      <a href="https://pnpm.io/">pnpm</a> ≥ v11 — mise installs a bootstrap copy; the
      <code>packageManager</code> pin in <code>package.json</code> stays the authority (pnpm
      self-switches to it via <code>manage-package-manager-versions</code> — corepack is removed
      from node 25+)
    </li>
    <li><a href="https://docs.docker.com/get-docker/">Docker</a> >= v20 — system platform declared in <code>mise.toml</code>'s <code>[bootstrap.packages]</code> and installed through the native package manager</li>
    <li><a href="https://www.openssl.org/">openssl</a> >= v3 (used by <code>infra/cloudflare.ts</code> for the 15-year origin TLS cert) and <a href="https://httpd.apache.org/docs/current/programs/htpasswd.html">htpasswd</a> (bcrypt hasher for the <code>${VAR | bcrypt}</code> template filter in <code>pnpm cluster deploy</code>; ships with macOS, <code>apache2-utils</code> on Debian, <code>apache</code> on Arch) — system packages declared in <code>[bootstrap.packages]</code></li>
    <li><a href="https://tailscale.com/download">Tailscale</a> — only required for production cluster access (<code>sudo tailscale configure kubeconfig prod-cluster</code>); not installed by <code>pnpm bootstrap</code>, install manually if you need prod access</li>
  </ul>

```sh
# fresh machine (recommended):
./scripts/bootstrap/main.sh all --global

# only if you already manage [_.global_tools] yourself:
./scripts/bootstrap/main.sh all
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
