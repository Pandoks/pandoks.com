---
paths:
  - '**/*.go'
  - '**/go.mod'
  - '**/go.sum'
---

# Code style — Go

Plain stdlib Go. No third-party logger, no fancy frameworks. Lives in
`packages/valkey/reconciler` (the CLI conventions below), plus the cluster-test
surface: `packages/testkit` (shared harness module — client-go + apimachinery
only; helm via the binary) and `packages/{postgres,valkey,clickhouse}/test`
(integration suites; each `replace`s `testkit`, all registered in `go.work` so
`pnpm lint go` fans out to them). Test-framework decision: plain `go test` +
client-go — e2e-framework/terratest were evaluated and rejected (both wrap the
helm binary anyway; their env/feature model fights ordered stateful scenarios).

## CLI shape

- `main()` reads `os.Args`, switches on subcommand, dispatches to
  `commands.<Name>(env)`. See `packages/valkey/reconciler/main.go:10-48`.
- Each subcommand follows
  `if err := ...; err != nil { fmt.Fprintln(os.Stderr, "error:", err); os.Exit(1) }`.

## Layout

- **`internal/` package layout**: one file per subcommand under
  `internal/commands/` (`init.go`, `scale-up.go`, `scale-down.go`).
- Shared utilities under `internal/utils/`, `internal/valkey/`.

## Errors

- `fmt.Fprintln(os.Stderr, "error:", err)` — no logrus / zap / slog.
- No structured logging library.
- Sentinel constant for the misuse-vs-runtime distinction.

## Exit codes

- **`2`** for misuse (no args, unknown command) —
  `packages/valkey/reconciler/main.go:13, 46`.
- **`1`** for runtime failure — `:21, 28, 34, 40`.
- **`0`** on success (implicit).

## Comments

- Sparse, only for non-obvious WHY. Real examples:
  `packages/valkey/reconciler/internal/commands/scale-down.go:234, 409, 471`,
  `packages/valkey/reconciler/internal/valkey/info.go:70, 260`,
  `packages/valkey/reconciler/internal/valkey/cli.go:64, 138, 320`.
