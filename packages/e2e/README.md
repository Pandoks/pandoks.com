# e2e

Shared [Ginkgo v2](https://onsi.github.io/ginkgo/) and [Gomega](https://onsi.github.io/gomega/)
helpers for end-to-end suites on local k3d. Each package keeps its own `e2e/` module so path filters
run only affected suites; CI runs them in
[.github/workflows/e2e.yaml](../../.github/workflows/e2e.yaml) between `build.yaml` and
`publish.yaml`.

## Running a Suite

Run from the repo root (Valkey example; for Postgres, see
[packages/postgres/README.md](../postgres/README.md#end-to-end-tests)):

1. Start k3d without changing your default kubectl context:

   ```sh
   previous_context="$(kubectl config current-context)"
   pnpm cluster k3d deps up && pnpm cluster k3d up
   kubectl config use-context "${previous_context}"
   ```

2. Build and push the package's images (`@pandoks.com/<package>`), and re-run this step after
   editing them:

   ```sh
   pnpm --filter @pandoks.com/valkey local:build && pnpm --filter @pandoks.com/valkey local:push
   ```

3. Run the suite:

   ```sh
   go tool ginkgo -p ./packages/valkey/e2e -- \
     --valkey-image=local-registry:5000/valkey:latest \
     --valkey-reconciler-image=local-registry:5000/valkey-reconciler:latest
   ```

> [!WARNING]
> Ginkgo's `-p` scales concurrency to the host CPU count. On an 8 GiB Docker VM, `-p` caused etcd
> timeouts and crashed the k3d server containers, while `--procs=3` ran clean; pass `--procs=3`
> locally instead. CI runs `-p`.

| Suite                     | Image flags                                                                                        | Installed by suite                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `./packages/valkey/e2e`   | `--valkey-image`, `--valkey-reconciler-image`                                                      | ServiceMonitor CRD, `valkey-reconciler` ClusterRole                             |
| `./packages/postgres/e2e` | `--patroni-image`, `--pgbackrest-image`, `--previous-patroni-image`, `--previous-pgbackrest-image` | ServiceMonitor CRD, `patroni` ClusterRole, `cert-manager`, `internal-ca-issuer` |

- **Charts:** Suites load charts from the checkout, except Postgres's upgrade and revert specs,
  which first install `main`'s published chart from GHCR using `--previous-patroni-image` and
  `--previous-pgbackrest-image` (built from `main` on Apple Silicon).
- **Images:** Omitted image flags use chart defaults on GHCR (`linux/amd64` only), so on Apple
  Silicon pass every image flag listed above.
- **Filtering:** Pass `--label-filter` to run a subset, or `--dry-run -v` to list specs.
- **Teardown:** Run `pnpm local:destroy` to tear down k3d and local dependencies.

## Adding a Suite

1. Create `packages/<package>/e2e` as module `<package>/e2e` requiring `e2e v0.0.0` with
   `replace e2e => ../../e2e`, add it to [go.work](../../go.work), and run `go mod tidy` in
   `packages/<package>/e2e` (`pnpm lint go`, `pnpm format go`, and `govulncheck` cover every
   `go.work` module).
2. Add `<package>_suite_test.go` calling `e2e.RunSuite` with a `SynchronizedBeforeSuite` for cluster
   prerequisites (`e2e.ApplyServiceMonitorCRD`, required RBAC, and any CRDs or issuers the chart
   expects).
3. Put specs in `Describe("<Package>", Label("<package>"), ...)`: group dependent steps in `Ordered`
   with install in `BeforeAll`, mark cluster-disruptive specs `Serial`, and pass `.WithTimeout(...)`
   for `Eventually` waits over 1 minute.
4. Add one `--<image>-image` flag per first-party image, overriding the chart value only when set so
   omitting it tests the chart's default.
5. In [.github/workflows/changes.yaml](../../.github/workflows/changes.yaml), add a `<package>`
   filter (its paths plus `*needs-e2e-setup`) under `e2e-changes` and add `<package>` to `suites` in
   `set-e2e-matrix`.

## Helpers

Defined in [e2e.go](./e2e.go). Add a helper here only once more than one suite needs it.

| Helper                   | Behavior                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Run` / `MustRun`        | Runs `kubectl` or `helm` pinned to `k3d-local-cluster` (no cluster override)                                                                                                                      |
| `RunSuite`               | Runs specs with shared `Eventually` defaults (`1m` timeout, `2s` poll)                                                                                                                            |
| `ApplyServiceMonitorCRD` | Server-side applies Prometheus Operator CRDs from [kustomization.yaml](./kustomization.yaml) when absent and waits until `Established`                                                            |
| `InstallChart`           | Creates a fresh namespace and credentials secret, runs `UpgradeChart`, and registers cleanup (dumps pods, jobs, StatefulSets, events, and logs on failure; uninstalls release; deletes namespace) |
| `UpgradeChart`           | Runs `helm upgrade --install --reset-then-reuse-values --timeout=5m` from a chart dir or OCI ref                                                                                                  |
