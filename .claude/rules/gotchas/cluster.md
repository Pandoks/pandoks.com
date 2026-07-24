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

- **Topology lives in `infra/cluster/config.ts` as generic primitives.**
  `PRODUCTION_CLUSTER_CONFIG` and `NON_PRODUCTION_CLUSTER_CONFIG` both currently
  declare zero clusters. A cluster is an entry (`region`, `pools`), one per
  region with its index allocated in `CLUSTER_NETWORK_INDEXES`; pools mix
  Public Cloud and dedicated via the
  `server` union and use raw labels/taints for placement. Fill dedicated
  catalog fields only for a pool with a non-zero count, validated against the
  live authenticated cart. CI retains only the OVH credentials; Pulumi creates
  the Public Cloud project and passes its generated ID directly. CI runs the
  TypeScript topology contracts.
  Cluster resources use `protect: isProduction`: production nodes are protected
  and non-production nodes are not. When no nodes are declared, stale OVH
  cluster Tailnet entries are reclaimed. Scale-down can target only the
  selected pool's `count - 1` node and requires a separate reviewed IaC
  unprotect change in production.

## Regional networking

- **Clusters are independent under one US account.** Every cluster runs on the
  single `ovh-us` account and one global vRack; non-US clusters are
  dedicated-only (US Public Cloud regions are US-only). Each cluster owns
  unique node, pod, service, and MetalLB CIDRs derived from the region's
  `CLUSTER_NETWORK_INDEXES` entry.
  Flannel does not provide cross-cluster pod/service connectivity; dedicated
  pools with `interconnect: true` share a cross-cluster VLAN for private L3
  (e.g. database replication), while app-level wiring is a separate rollout.
- **Do not stretch a managed Gateway/LB subnet across regions.** OVH supports
  vRack/VLAN extension, but its managed Gateway and Load Balancer require the
  single-region private networks modeled here. The interconnect VLAN carries
  no managed products — only raw dedicated-server VLAN subinterfaces.

## Tailscale operator

- **Prod-only.** `k3s/base/core/tailscale.yaml:2` comments this. Dev k3d
  has no operator.

## ArgoCD CMP

- **The CMP renders via the cluster CLI** — `argocd-plugin.yaml` calls
  `deploy prod --region "$CLUSTER_REGION" --dry-run --quiet` inside the
  repo-server pod. The optional `argocd/pandoks-cluster` ConfigMap value defaults
  to `us-west` for compatibility. If the CLI contract changes, update and bump
  the CMP schema name together.

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

## Charts / builds

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

- **Only `k3d` and `deploy` exist** (`scripts/cluster/main.sh:23-30`).
  `scripts/cluster/README.md` is the canonical reference for subcommand
  flags, env tags, and template variables — keep it in sync with
  `scripts/cluster/usage.sh` when adding options.

## Regional deploy skip

- `.github/workflows/deploy-infra.yaml` reads enabled production regions from
  `scripts/cluster/config.ts`, then independently syncs each visible regional
  Tailscale operator. With every region disabled, the job exits successfully
  without contacting a cluster.

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
