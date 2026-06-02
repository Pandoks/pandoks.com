---
paths:
  - 'packages/valkey/reconciler/**'
  - 'packages/valkey/Dockerfile'
  - 'packages/valkey/chart/**'
---

# Gotchas — Valkey reconciler (`packages/valkey/reconciler/`)

A Go binary invoked by Helm hooks and init containers to initialize and
reconcile a StatefulSet-backed Valkey cluster. Runs once per invocation
(not a daemon). Uses in-cluster Kubernetes auth + direct pod-to-pod
networking via the headless service.

## What each subcommand does

- **`init`** (`packages/valkey/reconciler/internal/commands/init.go:14-93`):
  Wait for StatefulSet replicas → build pod FQDNs by index math → run
  `valkey-cli --cluster create` → print final state. Hard-stops on
  `cluster_state:ok` so re-runs are idempotent.
- **`scale-up`** (`packages/valkey/reconciler/internal/commands/scale-up.go:16-98`):
  Wait for StatefulSet → query `CLUSTER NODES` → add missing masters
  (index-ordered) → add replicas to balance `ReplicasPerMaster` →
  rebalance slots with `--cluster-use-empty-masters`. Asserts topology
  is healthy as the FINAL gate before rebalancing — not before starting
  — in `finalizeScaleUp` (`scale-up.go:327`, `IsHealthy()`).
- **`scale-down`** (`packages/valkey/reconciler/internal/commands/scale-down.go:15-118`):
  Query state → remove extra shards → remove extra replicas → **move
  masters out of the "danger zone"** (indices ≥ desired count) by
  promoting a lower-indexed replica
  (`moveMastersToSafeSpots()` at `:107`) → delete danger-zone nodes.
  The master-relocation step is the load-bearing safety mechanism —
  StatefulSet pod eviction would otherwise kill an active master.

## Key abstractions (`internal/valkey/`)

| File          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topology.go` | `Topology` struct with `Masters`, `Slaves`, `OrderedNodes` (by StatefulSet index), `OrderedShards` (by lowest node index). `IsHealthy()` at `:79-118`.                                                                                                                                                                                                                                                                                                         |
| `nodes.go`    | `ClusterNode` parses `CLUSTER NODES` output. `Index()` extracts the StatefulSet ordinal from `valkey-{cluster}-{N}`; returns `-1` on parse failure.                                                                                                                                                                                                                                                                                                            |
| `cli.go`      | Wrappers around `valkey-cli --cluster` subcommands (rebalance, add-node, del-node, create). Options structs validate auth up front.                                                                                                                                                                                                                                                                                                                            |
| `client.go`   | Thin `ValkeyClient` over valkey-go. **Embeds `valkeygo.Client` anonymously** (`client.go:7-10`), so every method on the underlying client (`Do`, `Receive`, etc.) is callable directly on `*ValkeyClient`. The embedded field is also accessible as `.Client` when a helper needs the raw `valkeygo.Client` (e.g., `GetClusterInfo(client.Client)`). `Refresh()` swaps the underlying client without mutating the original options struct (`client.go:25-26`). |
| `info.go`     | Semaphore-bounded (10) parallel polling helpers — `WaitFor*ClusterNodeContains` ensure cluster-wide bus convergence before continuing.                                                                                                                                                                                                                                                                                                                         |
| `shard.go`    | `PromoteOriginalShardLeader()` issues `CLUSTER FAILOVER`, polls `INFO replication` until both old + new leader agree (`shard.go:19-95`).                                                                                                                                                                                                                                                                                                                       |
| `print.go`    | Pretty-print helpers for status output.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Env loading (`internal/utils/`)

Required env vars loaded once in `main()` and passed as an `Env` struct
through every command (`packages/valkey/reconciler/internal/utils/env.go:17`):

- `CLUSTER_NAME` — prepended to `valkey-{name}` pod and service names.
- `NAMESPACE` — K8s namespace.
- `MASTERS` — desired master count.
- `REPLICAS_PER_MASTER` — desired replica count per master.
- `ADMIN_PASSWORD` — Valkey cluster password.

In production these come from the Helm chart's `values.yaml` injected
into the hook Job's container env (see "Helm-hook wiring" below).
`kubernetes.go:15-55` exposes:

| Helper                                          | What                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `GetClusterServiceFQDN(name, ns)`               | Headed cluster service FQDN.                                |
| `GetHeadlessServiceFQDN(name, ns)`              | Headless service FQDN — used as seed for cluster discovery. |
| `GetPodHeadlessServiceFQDN(name, ns, index)`    | Per-pod FQDN, used to address pod N directly.               |
| `GetStatefulsetName(name)`                      | StatefulSet name — `valkey-{name}`.                         |
| `GetStatefulsetPodName(name, index)`            | Pod name at index — `valkey-{name}-{index}`.                |
| `GetAllServicePods(serviceFQDN)`                | Uses `net.LookupSRV()` for DNS-based discovery.             |
| `WaitForStatefulSetReady(ctx, ns, name, count)` | Polls in-cluster API until ready.                           |

## Helm-hook wiring (`packages/valkey/chart/templates/hooks.yaml`)

Subcommands are invoked by Helm hooks, one Job per subcommand. The
pattern at `packages/valkey/chart/templates/hooks.yaml:1-52` (`init`
hook) is the template — every subcommand needs its own Job block:

| Subcommand   | Helm hook annotation           | Cited in `hooks.yaml` |
| ------------ | ------------------------------ | --------------------- |
| `init`       | `"helm.sh/hook": post-install` | `:7`                  |
| `scale-up`   | `"helm.sh/hook": post-upgrade` | `:60`                 |
| `scale-down` | `"helm.sh/hook": pre-upgrade`  | `:113`                |

Shape: each Job sets `args: [<subcommand>]` and injects the 5 required
env vars (`CLUSTER_NAME`, `NAMESPACE`, `MASTERS`, `REPLICAS_PER_MASTER`,
`ADMIN_PASSWORD`) — `hooks.yaml:31-48`. **Also replicate these per-Job
hook fields:**

- `"helm.sh/hook-weight": "0"` on every Job (`hooks.yaml:8, 61, 114`) —
  if a new post-upgrade Job must run AFTER `scale-up`, give it a HIGHER
  weight; equal weights leave ordering non-deterministic.
- `"helm.sh/hook-delete-policy"` templated from
  `.Values.hooks.hookDeletePolicy` (`values.yaml:29` =
  `before-hook-creation,hook-succeeded`).
- `post-upgrade` fires only on `helm upgrade`, **NOT** initial
  `helm install` — add `post-install` too if first-install coverage is
  needed. Literal: `"helm.sh/hook": post-install,post-upgrade`
  (comma-list) or a second annotation. Existing hook annotations are
  string values (`hooks.yaml:7, 60, 113`).

**RBAC:** the chart's `rbac.yaml` defines only the ServiceAccount
`valkey-{name}-reconciler` + a RoleBinding; the actual `ClusterRole`
`valkey-reconciler` (get/list/watch on pods + statefulsets only, no
write verbs — `k3s/base/core/valkey.yaml:5-21`) lives OUTSIDE the
chart. The reconciler does only K8s **reads** (Gets StatefulSets) and
performs all cluster mutation over the network via
`valkey-cli`/valkey-go — so a new **read-only** subcommand needs **NO
RBAC change**. The boundary is **verb-scoped, not resource-scoped**: a
subcommand that mutates a K8s object — even the SAME resource
(`patch`/`update`/`delete`/`scale` on `statefulsets`) — must add the
verb to the ClusterRole, because the grant is read-only today. A brand
new resource type needs a new rule block too. Image is
`.Values.cluster.reconcilerImage`, securityContext is
`readOnlyRootFilesystem + drop ALL caps`, `/tmp` is the only writable
mount.

**Adding a new subcommand requires wiring a hook Job** if it should
run automatically. Manual one-shot ops (`reshard`, `diag`, `status`)
can skip the hook and be invoked via `kubectl exec`/`kubectl run`
against the reconciler image:

```sh
kubectl run -it --rm valkey-<name>-<cmd> \
  --image=<reconcilerImage> \
  --restart=Never \
  --command -- /reconciler <cmd>
# (with the same 5 env vars sourced from the credentials Secret)
```

If the subcommand should be triggered by a chart event (e.g., always
run `diag` after an upgrade), add a Job block to `hooks.yaml` copying
the `scale-up` shape and swapping `args:` + the hook annotation.

## Idempotency + state assumptions

- All commands assume **the cluster is reachable and pods 0..N-1 are
  DNS-resolvable** at invocation time. The reconciler will not bring up
  Valkey itself — it expects the StatefulSet to be running.
- Bus port `16379` must be open between pods (gossip protocol).
- `ADMIN_PASSWORD` must be valid at invocation time. **A credential
  rotation mid-operation breaks every subsequent call** — no fallback,
  no retry with old/new passwords.
- All three subcommands are safe to re-run if topology hasn't changed
  (`init` short-circuits on `cluster_state:ok`; scale ops compute diff
  from observed `CLUSTER NODES`).

## When to use `WaitForStatefulSetReady`

The mutating commands `init` (`init.go:31`) and `scale-up`
(`scale-up.go:25`) call it first because they need a steady starting
state. **`scale-down` does NOT call it** — it instead asserts
`Topology.IsHealthy()` up front (`scale-down.go:36`). **Read-only
commands should NOT block on full readiness** — they should report
whatever they see. If you add a read-only subcommand (status, inspect,
diag), skip `WaitForStatefulSetReady` and let the valkey client surface
unreachable seeds as errors. A degraded cluster with `<totalNodes`
ready pods would otherwise hang for the wait's context timeout (5 min
in `init`, 10 min in `scale-up`) before producing output.

**For the health verdict itself, reuse `Topology.IsHealthy()`**
(`topology.go:79-118`) — the same `(bool, error)` predicate that
`scale-up` (`scale-up.go:327`) and `scale-down` (`scale-down.go:36`)
gate on. A read-only command can return its `error` directly to get
the exit-1 mapping (don't invent a new health criterion — the codebase
already has one).

## Exit-code semantics

| Code | Meaning                                                                | Cited in main.go           |
| ---- | ---------------------------------------------------------------------- | -------------------------- |
| `0`  | Success — implicit.                                                    | (no explicit `os.Exit(0)`) |
| `1`  | Runtime failure — any `err != nil` from env load or command execution. | `main.go:21, 28, 34, 40`   |
| `2`  | Misuse — no args, unknown subcommand.                                  | `main.go:13, 46`           |

There is no separate "operation succeeded but observed state is
unhealthy" code. A read-only subcommand that reports an unhealthy
cluster should still return an error (mapped to exit `1`) — surface
the unhealth as the failure, not as a third code. Don't invent exit
codes outside this table.

## Shared error sentinels

Subcommand-specific sentinels live in the file that owns them
(e.g., a sentinel only `Status` returns lives in `status.go`).
Sentinels that span multiple subcommands go in a new file
`internal/commands/errors.go` (none exist yet — the first one creates
it). `main.go` should NOT branch on specific sentinels; it remains a
flat switch with one `error != nil → exit 1` arm per case. Sentinels
are for _internal_ differentiation (logging detail, callers in
`internal/valkey/`), not for shaping the exit-code surface.

## Load-bearing comments — don't remove

Citations to the WHY behind subtle code. When touching these areas,
preserve or update the comment too.

- `internal/valkey/info.go:70` — `LookupSRV()` returns bus-port records
  too; filter to client port `6379` or you'll dial non-existent addrs.
- `internal/valkey/info.go:260-264` — bus propagation is async; clients
  may hit a stale node before convergence. Wait for **all** nodes to
  agree before continuing.
- `internal/commands/scale-down.go:234` — `makeRoomForMasters()` assumes
  topology was healthy at function entry; without that guarantee, a
  master with no safe-zone replica blows up the whole function.
- `internal/commands/scale-down.go:409-410` —
  `moveMastersToSafeSpots()` requires at least one replica outside the
  danger zone. If every replica is in the zone, failover can't promote.
- `internal/commands/scale-down.go:471` — danger-zone nodes may already
  be evicted from `CLUSTER NODES`. Iterate `OrderedNodes` and test
  `Index()`; do not blindly slice.
- `internal/valkey/cli.go:135` — `AddNode` does NOT add replicas
  directly — a CLI race condition forces empty-master + `CLUSTER
REPLICATE` instead.
- `internal/valkey/client.go:25-26` — `Refresh()` must NOT mutate
  original options; the caller relies on being able to fall back.

## Footguns

1. **Pod-name parsing is index-of-truth.** A misnamed StatefulSet pod
   parses to `Index() === -1` and the safe-zone math silently
   misidentifies which nodes to keep. The cluster name in
   `CLUSTER_NAME` env must match the StatefulSet name exactly.
2. **Failover loop has no inner timeout.** `PromoteOriginalShardLeader`
   polls `INFO replication` every 200ms; only the outer context
   deadlines it. A hung failover hangs the whole scale-down.
3. **Concurrency cap = 10.** `WaitForAllNodesClusterNodeContains` runs
   bounded by 10 goroutines. For >10 nodes the polls serialize and may
   approach the 5-minute timeout.
4. **`Rebalance()` trusts exit code.** If `valkey-cli --cluster
rebalance` partially succeeds but leaves the cluster inconsistent,
   the error bubbles up but slot ownership is already wrong. There is
   no post-rebalance validation step.
5. **No retry on auth failure.** Wrong/rotated password produces
   error-and-exit; do not "fix" this by silently retrying with a
   different secret — surface the rotation problem instead.

## Test layout

- `internal/valkey/nodes_test.go` — table-driven tests for
  `ClusterNode.Index()` and `addressParts()` parsing (valid/invalid
  FQDNs, IPv6, malformed ports).
- `internal/valkey/topology_test.go` — `ClusterTopology()` builder
  integration tests (master-replica relationships, ordering, shard
  index calculation).

Pattern: struct table with `name`, inputs, expected outputs, optional
`errSubstr`. Use `t.Run(tt.name, ...)` for subtest naming. Add tests for
both happy paths and parse-failure cases — `-1` and empty-string
fallbacks are the surface area most likely to break silently.

## Build + run

- Build: `pnpm --filter @pandoks.com/valkey run docker:build` (chart
  pushes to ghcr).
- Lint: `pnpm lint go`.
- Test: `pnpm --filter @pandoks.com/valkey test` (runs
  `go test -C ./reconciler -v ./...`).
- Style: see `.claude/rules/conventions/go.md` for naming, error,
  comment, and exit-code conventions.
