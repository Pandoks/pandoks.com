# Workflows

Always-loaded. Install / dev / build / lint / typecheck / deploy commands.
Mirrors `.github/workflows/*.yaml` exactly.

## Required tools

Declared in `mise.toml`, installed by [mise](https://mise.jdx.dev/)
(`pnpm bootstrap all` bootstraps mise then runs `mise install`; bare
`pnpm bootstrap` just prints help — the script is `bootstrap`, NOT
`setup`, because pnpm's builtin `setup` command shadows that name).
Every entry is
an exact pinned literal Renovate bumps through its native mise manager.
Three pins are bootstraps with an external authority: **go** —
`go.work`'s directive rules; GOTOOLCHAIN auto-runs what it demands, so
mise-pin drift is harmless. **kubectl** — the prod pin is
`KUBECTL_VERSION` in `packages/argocd/Dockerfile`; clients tolerate ±1
minor and Renovate's `kubectl` group PR keeps the two copies in sync.
**pnpm** — the `packageManager` pin in `package.json:4` is the
authority (pnpm ≥10 self-switches to it — the post-corepack mechanism;
corepack is removed from node 25+). Python pairs with uv (mise =
interpreter, uv = project deps; `UV_PYTHON_PREFERENCE=system` in mise's
`[env]`). Outside mise: Docker ≥ v20 and openssl/htpasswd (system
packages).
CI provisions per-job subsets via SHA-pinned `jdx/mise-action` with
`install_args`.

## Install

```sh
pnpm install          # auto-runs `sst install` via postinstall (package.json:24)
pnpm run sso          # AWS SSO; 12-hour validity
```

`pnpm run sso` is `aws sso login --sso-session=Pandoks_ --use-device-code --no-browser`
(`package.json:11`). The `~/.aws/config` file (including the
`[sso-session Pandoks_]` block and per-account profiles) is written by
the AWS-config heredoc in `install_aws_config` (`scripts/bootstrap/install.sh:88-122`) — see
`gotchas/bootstrap.md` for the maintenance rule (the heredoc is hardcoded
to the Pandoks\_ org and must be updated in lockstep with any AWS
Identity Center / profile / account-ID change).

## Env files

Create `.env.<stage>` files per `.env.example`. SST defaults to a stage
matching the local username (`pandoks`). Production always needs
`--stage production` explicitly.

Required envs (`.env.example`): `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_DEFAULT_ACCOUNT_ID`, `HCLOUD_TOKEN`,
`TAILSCALE_OAUTH_CLIENT_ID`, `TAILSCALE_OAUTH_CLIENT_SECRET`,
`GITHUB_TOKEN`. The Tailscale pair is the manually-created root OAuth
client (admin console → Trust credentials, "All - Read & Write",
tagless — see `gotchas/infra.md`) — the one
credential IaC can't create; its secret never expires. The provider
exchanges it for 1-hour API tokens per run (`sst.config.ts:18-22`), and
`deleteTailscaleDevices` does the same exchange for its raw API calls
(`infra/tailscale.ts:92-109`).

## Dev (SST)

```sh
pnpm run dev          # = sst dev
```

`sst dev` proxies workspace `dev` scripts. `apps/web` runs
`portless run --name web vite dev` (`apps/web/package.json:7`). The
`portless` wrapper provides stable hostnames per service.

## Dev (local k3d cluster)

```sh
pnpm run dev:init     # deps up → k3d up → docker:build → dev:push → bootstrap → deploy dev
pnpm run dev:destroy  # k3d down → docker compose deps down
```

Decomposed (`package.json:14-15`):

```sh
pnpm run cluster k3d deps up
pnpm run cluster k3d up
pnpm run docker:build
pnpm run dev:push
pnpm run cluster deploy dev --bootstrap
pnpm run cluster deploy dev
```

Cluster CLI subcommands (`scripts/cluster/main.sh`, `usage.sh`):

```sh
pnpm run cluster k3d {up|down|start|stop|restart|deps {up|down|restart}}
pnpm run cluster deploy {local|dev|prod} [--bootstrap] [--stage NAME]
                                          [--dry-run] [--kubeconfig PATH]
                                          [--quiet|-q]
```

Zero-arg invocation prints help; there is no `all` subcommand. `deploy prod`
auto-overrides the SST stage to `production`
(`scripts/cluster/deploy.sh:182` — `[ "${cmd_deploy_env}" = "prod" ] && cmd_deploy_stage="production"`).

> Root `README.md` and `k3s/README.md` reference `cluster sst-apply` /
> `cluster sync` / `cluster setup` — **those subcommands don't exist in the
> current CLI**. Only `k3d` and `deploy` are dispatched.

## Build

`apps/web` build is plain `vite build` (`apps/web/package.json:8`). Notion
content is fetched out-of-band by `apps/web/scripts/notion.ts` (invoked
via `sync-notion.yaml`). Build-time blog-route hiding is a Vite plugin —
`apps/web/vite/plugins/hide-blog.ts` (registered in
`apps/web/vite.config.ts:13`).

```sh
pnpm --filter @pandoks.com/web run build
```

## Check / lint / format / fix

Root scripts (`package.json:19-22`) are language dispatchers — zero-arg
invocation prints help; explicit subcommand required to fan out.

```sh
pnpm check                  # `pnpm -r --if-present check && pnpm check:infra`
pnpm check:infra            # `tsc -p .` — typecheck infra/**
pnpm lint <lang>            # = ./scripts/lint/main.sh <lang>
pnpm format <lang>          # = ./scripts/format/main.sh <lang>
pnpm format check <lang>    # check-only mode (no writes)
pnpm fix <lang>             # = ./scripts/fix/main.sh <lang>
```

| Dispatcher    | Subcommands                                             | Underlying tools                                                               |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm lint`   | `js`, `go`, `helm`, `docker`, `shell`, `actions`, `all` | ESLint / golangci-lint / helm+kubeconform / hadolint / shellcheck / actionlint |
| `pnpm format` | `js`, `go`, `shell`, `all`, plus `check` mode           | Prettier --write / golangci-lint fmt / shfmt -w                                |
| `pnpm fix`    | `js`, `go`, `all`                                       | `eslint . --fix` / `golangci-lint run --fix`                                   |

Per-workspace `check`:

- `apps/web` and `packages/svelte`: `svelte-kit sync && svelte-check --tsconfig ./tsconfig.json` (`apps/web/package.json:12`, `packages/svelte/package.json:11`).
- `apps/functions`: `tsc --noEmit` (`apps/functions/package.json:6`).
- `packages/valkey`: Go tests run from `packages/valkey/reconciler`; no
  per-workspace `check` script — Go linting runs via `pnpm lint go`.
- Root: `pnpm check:infra` (`tsc -p .` at repo root) typechecks
  `infra/**` + `sst.config.ts`.

## Test

No root `test`. Per-app:

```sh
pnpm --filter @pandoks.com/web run test            # `pnpm run /^test:/` → vitest + playwright
pnpm --filter @pandoks.com/desktop-template run test
pnpm --filter @pandoks.com/svelte run test
# packages/valkey: go test from packages/valkey/reconciler
```

`apps/web/vite.config.ts:30-55` defines two vitest projects (`client`
jsdom, `server` node) — single `pnpm test:unit` runs both.

## Deploy — SST

```sh
pnpm sst deploy --stage production
pnpm sst deploy --stage production --target PersonalWebsite   # web only
pnpm sst refresh --stage production                           # state refresh
pnpm sst secret set <Name> --stage <stage>
```

`deploy-infra.yaml` deploys the full SST stack. Web rebuilds for Notion
content changes happen via `sync-notion.yaml` (`workflow_dispatch`, fired
by the Notion webhook handler through GitHub's API).

## Deploy — Kubernetes (manual)

```sh
sudo tailscale configure kubeconfig prod-cluster

sudo kubectl annotate application prod-cluster \
  argocd.argoproj.io/refresh=hard --overwrite --namespace argocd
```

Then wait for ArgoCD sync (CI's loop is in
`.github/workflows/deploy-infra.yaml:145-162`).

## CI workflows

| File                     | Triggers                                                                                                                                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-infra.yaml`      | push to main on `infra/**`, `apps/**` (excl. `desktop-template`/`example`), `packages/svelte/**`, `k3s/**`, `scripts/cluster/**`; manual dispatch (`stage`/`deploy` inputs) | Install, AWS OIDC, `pnpm sst refresh` (`continue-on-error: true`, `:98-102`), `pnpm sst deploy`. On success: Tailscale + ArgoCD `refresh=hard` + sync-wait loop (60×5s, `:151-162`). Skips kubernetes step if no `prod-cluster` Tailnet peer (`:133-140`). Each job uses `concurrency: { cancel-in-progress: false }`.                                                                       |
| `sync-notion.yaml`       | `workflow_dispatch` only (fired by `NotionWebhookHandler` Lambda via GitHub API)                                                                                            | Install, AWS OIDC, run `pnpm sst shell --stage production -- pnpm -r --if-present run sync:notion`. Opens a PR (`peter-evans/create-pull-request@v8`) under branch `auto/notion-sync` with content under `apps/web/*`.                                                                                                                                                                       |
| `checks.yaml`            | push to main, PR to main                                                                                                                                                    | paths-filter dispatches per-language jobs (prettier, eslint, golangci, shfmt+shellcheck, hadolint, helm+kubeconform, actionlint, renovate-config-validator, `pnpm check:infra` via `infra` filter). Tool-only jobs (shell/helm) provision via `jdx/mise-action` reading `mise.toml` and invoke the dispatcher scripts directly (no pnpm). Each job runs only when its file patterns changed. |
| `tests.yaml`             | push to main, PR to main                                                                                                                                                    | paths-filter per-app: web (vitest + playwright), desktop-template, svelte package, valkey reconciler (go test). Each gated by `apps/web/**`-style globs.                                                                                                                                                                                                                                     |
| `security.yaml`          | push to main, PR to main, daily 17:00 UTC cron, manual dispatch                                                                                                             | Trivy scans on **published** images (not pre-build) plus config-scan on `k3s/**`. Findings upload to GitHub code-scanning.                                                                                                                                                                                                                                                                   |
| `build-and-publish.yaml` | push to `packages/{postgres,valkey,argocd,clickhouse}/**`; branch create; manual dispatch                                                                                   | paths-filter detects changes (skipped on `workflow_dispatch` → all rebuild). Matrix builds each Dockerfile **from repo-root context** (`context: .` at `:185`), pushes to `ghcr.io/<owner>/<image>` with SLSA attestation, tags main builds as `ref-main-<sha>` (#57). Matrix packages charts to `oci://ghcr.io/<owner>/charts`.                                                             |
| `branch-cleanup.yaml`    | `on: delete` (branch deletion)                                                                                                                                              | Three matrix jobs: delete Cloudflare Pages previews for the deleted branch, then delete GHCR image tags (`ref-<branch>-*`) for all 8 image packages, then delete GHCR chart tags (suffix `-<branch>`) for the 3 charts.                                                                                                                                                                      |
| `maintenance.yaml`       | daily 05:00 UTC cron + manual dispatch                                                                                                                                      | Two jobs: (1) Renovate via `renovatebot/github-action`; (2) `cleanup-packages` matrix — for each of 11 ghcr packages, keeps newest 30 `ref-main-<sha>` tags and prunes orphan untagged versions (preserves manifest children + provenance attestations).                                                                                                                                     |

Core actions pinned to v6: `actions/checkout@v6`, `actions/setup-node@v6`,
`aws-actions/configure-aws-credentials@v6`, `pnpm/action-setup@v6`,
`actions/setup-go@v6`. Other actions pin to their own latest majors —
`docker/setup-buildx-action@v4`, `docker/login-action@v4`,
`docker/build-push-action@v7`, `dorny/paths-filter@v4`,
`actions/attest-build-provenance@v4`,
`tailscale/github-action@v4`. Node version in CI is `'24.16.0'`
(exact pin — keep in sync with the `node` pin in `mise.toml`).

Trusted third-party actions outside the Anthropic-blessed set are
SHA-pinned with `# vN.N.N` comments — see every `uses:` in
`maintenance.yaml`, `build-and-publish.yaml`, `branch-cleanup.yaml`,
and the `jdx/mise-action` steps in `checks.yaml`. Do
not switch back to floating tags.

## SST stages

| Stage        | Notes                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `production` | `isProduction=true`, `STAGE_NAME='prod'`, `domain='pandoks.com'`, prod-only resources on (`infra/dns.ts:3, 5, 9`).                         |
| `pandoks`    | Dev / personal stage (defaults to local username). `domain='dev.pandoks.com'`. No `pandoks`-gated resources currently exist in `infra/**`. |

`StageName` and `AwsRegion` are auto-synced into SST secrets
(`infra/dns.ts:11-15` and `:22-27` respectively).
