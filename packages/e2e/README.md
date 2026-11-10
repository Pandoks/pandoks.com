# Chart e2e tests

End-to-end tests for the Helm charts in `packages/`, written with
[Ginkgo v2](https://onsi.github.io/ginkgo/) and [Gomega](https://onsi.github.io/gomega/). Each spec
installs a chart from its source directory with `helm` into a fresh namespace of the local k3d
cluster, waits for its hooks, exercises it with `kubectl`, and deletes the namespace afterwards
(dumping pods, events and logs first if it failed). Before the specs, the suite applies what the
charts expect from the cluster: the Prometheus Operator CRDs (`kustomization.yaml`, only if the
cluster has none yet) and the `valkey-reconciler` ClusterRole (`k3s/base/core/valkey.yaml`).

CI runs it in the `test-e2e` job of `.github/workflows/tests.yaml`.

## Running locally

From the repo root. `pnpm cluster k3d up` switches your default kubectl context, so save it first:

```sh
previous_context="$(kubectl config current-context)"
pnpm cluster k3d deps up && pnpm cluster k3d up
kubectl config use-context "${previous_context}"
pnpm --filter @pandoks.com/valkey local:build && pnpm --filter @pandoks.com/valkey local:push

mise exec -- go tool ginkgo -p ./packages/e2e
```

The suite only ever targets the `k3d-local-cluster` context. Rebuild and push a chart's images after
changing them; the chart itself is read from the checkout on every run. `pnpm local:destroy` tears
the cluster down.

## Labels

Each chart's specs carry its name as a label. Run only some with `--label-filter`, e.g.
`go tool ginkgo -p --label-filter=valkey ./packages/e2e`, and list them with `--dry-run -v`.

## Adding specs

- One `<chart>_test.go` per chart, with one `Describe("<Chart>", Label("<chart>"), ...)`.
- Install with `installChart` and change values with `upgradeChart`; both wait for the chart's
  hooks.
- Steps that build on each other go in an `Ordered` container with the install in `BeforeAll`, so a
  failed step skips the rest and the namespace is deleted once at the end.
- Mark specs that disrupt the whole cluster, like pausing a k3d node, `Serial`; `ginkgo -p` runs
  them alone after the parallel ones.
- `Eventually` waits 1 minute by default; give longer waits `.WithTimeout(...)`.
- A spec that needs another image adds its `local:build`/`local:push` to the `test-e2e` job and the
  package's paths to its `e2e` filter.
