---
paths:
  - 'k3s/**'
  - 'scripts/cluster/**'
  - 'scripts/lib/test.sh'
  - 'packages/argocd/**'
  - 'packages/*/test/**'
  - 'docker-compose.yaml'
  - '.github/workflows/build-and-publish.yaml'
  - '.github/workflows/deploy-infra.yaml'
  - '.github/workflows/cluster-tests.yaml'
---

# Gotchas — k3s + scripts + database packages

## Cluster state

- **Cluster size is currently 0** in `infra/vps/vps.ts:9, 11`. Code
  reclaims stale Tailnet entries when count is zero
  (`infra/vps/vps.ts:131-164`). Bumping counts brings the cluster up, but
  ArgoCD App-of-Apps then takes over.

## HAProxy

- **Proxy-protocol must stay on.**
  `infra/vps/load-balancers.ts:49` — flag is on to validate Cloudflare
  IPs; setting it false hides the client IP behind the LB private IP and
  breaks Cloudflare attribution.

## Tailscale operator

- **Prod-only.** `k3s/base/core/tailscale.yaml:2` comments this. Dev k3d
  has no operator.

## ArgoCD CMP

- **The CMP renders via the cluster CLI** — `argocd-plugin.yaml` calls
  `sh ./scripts/cluster/main.sh deploy prod --dry-run --quiet` inside the
  repo-server pod (see `packages/argocd/argocd-plugin.yaml`). If the CLI
  signature changes, the CMP breaks silently. **Version-bump
  `argocd-sst-plugin` image after CLI changes.**

## Kustomize quirks

- **`k3s/base/apps/kustomization.yaml`** must be applied with
  `kubectl apply --load-restrictor LoadRestrictionsNone` — it
  path-traverses (`../../../apps/example/kube`). The deploy CLI passes
  the flag automatically (`scripts/cluster/deploy.sh:79`).

## k3d

- **k3d API port is 6444**, not 6443 (`scripts/cluster/k3d.sh:37`) — so
  it doesn't conflict with the remote prod cluster's port over SSH.

## Namespaces

- **`k3s/base/core/postgres.yaml:55`**: `# NOTE: you need one service
account per namespace` — when adding new app namespaces, mirror the SA
  setup.

## LocalStack (docker-compose `s3` service)

- **Image is pinned to the 4.x community line** (`docker-compose.yaml` —
  `localstack/localstack:4.14.0`). Every later tag (2026.x+) hard-exits at
  startup demanding a `LOCALSTACK_AUTH_TOKEN` — the free community builds
  ended after 4.x. A Renovate rule caps it at `<5` (`renovate.json` —
  `allowedVersions` for `localstack/localstack`); don't "upgrade" past it.
- **The `s3` container has a static IP** (`172.30.0.254` on `pandoks-net`).
  k3d pods must reach it by that IP: `host.k3d.internal:4566` (hairpin NAT to
  the published port) is blocked on some docker hosts, and docker-DNS names
  like `s3` don't resolve from pods. The chart-default `host.k3d.internal`
  values still work where hairpin is allowed; the test suites override
  `s3.host`/`s3.endpoint` to the static IP.

## Charts / builds

- **apt/apk version pins in package Dockerfiles go stale upstream** — pgdg
  and Alpine delete superseded package versions, so an untouched Dockerfile
  can stop building at any time (Renovate doesn't manage distro-package
  pins). The failing image build is the signal; refresh by querying the base
  image: `docker run --rm <base> sh -c 'apt-get update >/dev/null;
apt-cache policy <pkg>'` (or `apk policy <pkg>`).
- **Dockerfile build context is repo root** for every package
  (`.github/workflows/build-and-publish.yaml:185` —
  `context: .  # WARN: all dockerfiles should have a context of the
root of the repo`). Never use the package dir as context.
- **`workflow_dispatch` rebuilds everything.**
  `.github/workflows/build-and-publish.yaml:119-125` (image dispatch) and
  `:136-142` (chart dispatch) skip the paths-filter on manual dispatch
  via `if [[ "${{ github.event_name }}" == "workflow_dispatch" ]]; then ... fi`
  and emit the full matrix — intentional escape hatch. (The paths-filter
  steps themselves carry the inverse `if: github.event_name != 'workflow_dispatch'`
  at `:72, :94`.)

## CLI subcommands

- **Only `k3d`, `deploy`, and `test` exist** (`scripts/cluster/main.sh:25-33`).
  `scripts/cluster/README.md` is the canonical reference for subcommand
  flags, env tags, and template variables — keep it in sync with
  `scripts/cluster/usage.sh` when adding options.
- **`test` never uses `cluster deploy`** (`scripts/cluster/test.sh`) — deploy
  needs SST/AWS creds; suites helm-install charts straight from
  `packages/<pkg>/chart` with hand-created secrets into `test-<pkg>`
  namespaces. Shared prep (cert-manager + internal CA, ServiceMonitor CRD,
  `monitoring`/`main` namespaces, postgres/valkey ClusterRoles) is idempotent.
  Per-package suites live at `packages/<pkg>/test/cluster.sh` (`test:cluster`
  scripts), shared helpers in `scripts/lib/test.sh`. Avoid `jq` in these
  scripts — CI's `jdx/mise-action` installs only `[tools]`, and `jq` is a
  `[_.global_tools]` pin; use `kubectl -o jsonpath` (in-pod `python3` for
  JSON, e.g. `patronictl list -f json`).

## Manual cluster deploy skip

- `.github/workflows/deploy-infra.yaml:133-140` sets `SKIP_DEPLOY=true`
  when no `prod-cluster` Tailnet peer is visible. Since both node counts
  are currently 0, this is the normal path.

## ghcr image lifecycle

- **`maintenance.yaml` cleans up ghcr.** Daily 05:00 UTC, per matrix
  entry: keep newest 30 `ref-main-<sha>` tags, then prune orphan
  untagged versions (preserves manifest children + provenance
  attestations). New image packages must be added to the matrix at
  `maintenance.yaml:34-44`.
- **`branch-cleanup.yaml`** removes both Cloudflare Pages previews and
  per-branch ghcr image/chart tags when a branch is deleted. Matrices
  at `branch-cleanup.yaml:38-46` (images) and `:84-88` (charts).
- Main builds tag images as `ref-main-<sha>` (#57) — the manifest list
  on multi-platform builds gets the tag, not the per-arch children.
