---
paths:
  - 'k3s/**'
  - 'scripts/cluster/**'
  - 'packages/argocd/**'
  - '.github/workflows/build-and-publish.yaml'
  - '.github/workflows/deploy-infra.yaml'
---

# Gotchas — k3s + scripts + database packages

## Cluster state

- **Cluster size is currently 0** in `infra/vps/vps.ts:9, 11`. Code
  reclaims stale Tailnet entries when count is zero
  (`infra/vps/vps.ts:131-164`). Bumping counts brings the cluster up, but
  ArgoCD App-of-Apps then takes over.

## HAProxy

- **Proxy-protocol must stay on.**
  `infra/vps/load-balancers.ts:48` — flag is on to validate Cloudflare
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
  the flag automatically (`scripts/cluster/deploy.sh:81`).

## k3d

- **k3d API port is 6444**, not 6443 (`scripts/cluster/k3d.sh:37`) — so
  it doesn't conflict with the remote prod cluster's port over SSH.

## Namespaces

- **`k3s/base/core/postgres.yaml:55`**: `# NOTE: you need one service
account per namespace` — when adding new app namespaces, mirror the SA
setup.

## Charts / builds

- **Dockerfile build context is repo root** for every package
  (`.github/workflows/build-and-publish.yaml:144` —
  `context: .  # WARN: all dockerfiles should have a context of the
root of the repo`). Never use the package dir as context.
- **`workflow_dispatch` rebuilds everything.**
  `.github/workflows/build-and-publish.yaml:79-89` (image dispatch) and
  `:100-110` (chart dispatch) skip the paths-filter on manual dispatch
  via `if [[ "${{ github.event_name }}" != "push" ]]; then ... fi` and
  emit the full matrix — intentional escape hatch.

## CLI subcommands

- **Only `k3d` and `deploy` exist** (`scripts/cluster/main.sh:23-30`).
  `scripts/cluster/README.md` is the canonical reference for subcommand
  flags, env tags, and template variables — keep it in sync with
  `scripts/cluster/usage.sh` when adding options.

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
  at `branch-cleanup.yaml:38-46` (images) and `:78-83` (charts).
- Main builds tag images as `ref-main-<sha>` (#57) — the manifest list
  on multi-platform builds gets the tag, not the per-arch children.
