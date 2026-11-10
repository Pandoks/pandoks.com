# e2e

Shared helpers for the end-to-end suites that test charts and apps on the local k3d cluster, written
with [Ginkgo v2](https://onsi.github.io/ginkgo/) and [Gomega](https://onsi.github.io/gomega/). This
module has no specs of its own: each package keeps its suite in its own `e2e/` directory, so a
change to one package only runs that package's suite, in its `test-<package>-e2e` job.

The helpers (`e2e.go`):

- `Run`/`MustRun` run `kubectl` or `helm` pinned to the `k3d-local-cluster` context; there is no
  option to point a suite at another cluster.
- `RunSuite` runs a suite with the shared `Eventually` defaults (1 minute timeout, 2 second polls).
- `ApplyServiceMonitorCRD` applies the Prometheus Operator CRDs the charts' monitoring templates
  need (`kustomization.yaml`), unless the cluster already has them.
- `InstallChart` installs a chart from its source directory into a fresh namespace with its
  credentials secret and waits for its hooks; after the spec or `Ordered` container it dumps pods,
  events and logs if anything failed, then deletes the namespace. `UpgradeChart` changes its values.

Only add a helper here once more than one suite needs it; anything for one chart stays in its suite.

## Running a suite

From the repo root. `pnpm cluster k3d up` switches your default kubectl context, so save it first:

```sh
previous_context="$(kubectl config current-context)"
pnpm cluster k3d deps up && pnpm cluster k3d up
kubectl config use-context "${previous_context}"
pnpm --filter @pandoks.com/valkey local:build && pnpm --filter @pandoks.com/valkey local:push

mise exec -- go tool ginkgo -p ./packages/valkey/e2e
```

Rebuild and push a package's images after changing them; the chart itself is read from the checkout
on every run. Run some specs with `--label-filter`, list them with `--dry-run -v`, and tear the
cluster down with `pnpm local:destroy`.

## Adding a suite

1. Create `packages/<package>/e2e` (or `apps/<app>/e2e`) as its own Go module, named
   `<package>/e2e`, that requires `e2e v0.0.0` with `replace e2e => ../../e2e`, add it to `go.work`,
   and run `go mod tidy` in it. `pnpm lint go`, `pnpm format go` and `govulncheck` cover every
   `go.work` module.
2. Add `<package>_suite_test.go` calling `e2e.RunSuite`, with a `SynchronizedBeforeSuite` that
   applies the cluster prerequisites the chart expects (`e2e.ApplyServiceMonitorCRD`, its RBAC).
3. Add specs in `Describe("<Package>", Label("<package>"), ...)`. Steps that build on each other go
   in an `Ordered` container with the install in `BeforeAll`, so a failed step skips the rest and
   the namespace is deleted once at the end. Mark specs that disrupt the whole cluster, like pausing
   a k3d node, `Serial`. Give `Eventually` waits longer than a minute `.WithTimeout(...)`.
4. In `tests.yaml`, add a `<package>-e2e` filter with the package's paths and `*needs-e2e-setup`,
   and a `test-<package>-e2e` job, copied from `test-valkey-e2e`, that builds and pushes only the
   images the suite needs and runs only that suite; add the job to `tests-pass`'s `needs`, and its
   `go.sum` to `lint-go`'s `cache-dependency-path` in `checks.yaml`.
