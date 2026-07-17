---
paths:
  - '**/*.go'
  - '**/go.mod'
  - '**/go.sum'
---

# Code style — Go

Plain stdlib Go. No third-party logger, no fancy frameworks.

`packages/queueworker` owns transport-neutral queue consumption: bounded
concurrency, handler timeouts, cancellation, acknowledgment, retry/discard,
and generic `slog` events. Its `sqs` subpackage is the current transport
adapter. `apps/push-worker` owns job decoding, provider dispatch, APNs/FCM
clients, configuration, and push-specific logs. Keep provider types out of the
shared package and AWS SDK types out of the runner.

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
