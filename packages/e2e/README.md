# e2e

Shared helpers for the end-to-end suites that test charts and apps on the local k3d cluster, written
with [Ginkgo v2](https://onsi.github.io/ginkgo/) and [Gomega](https://onsi.github.io/gomega/). This
module has no specs of its own: each package keeps its suite in its own `e2e/` directory, so a
change to one package only runs that package's suite. CI runs them from `e2e.yaml`, between building
and publishing the images.

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

mise exec -- go tool ginkgo -p ./packages/valkey/e2e -- \
  --valkey-image=local-registry:5000/valkey:latest \
  --valkey-reconciler-image=local-registry:5000/valkey-reconciler:latest
```

For Postgres, build and push `@pandoks.com/postgres` and pass `--patroni-image` and
`--pgbackrest-image` to `./packages/postgres/e2e`; its suite installs cert-manager itself.

The chart is read from the checkout on every run. An image flag left out uses the chart's default,
main's image on GHCR, which is `linux/amd64` only, so on Apple Silicon pass every image; rebuild and
push one after changing it.

Run some specs with `--label-filter`, list them with `--dry-run -v`, and tear the cluster down with
`pnpm local:destroy`.

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
4. Give the suite a `--<image>-image` flag per first-party image, named after the image, set only
   when given, so it otherwise tests the chart's default.
5. In `changes.yaml`, add a `<package>` filter (its paths plus `*needs-e2e-setup`) to `e2e-changes`
   and the package to `suites` in `set-e2e-matrix`.
