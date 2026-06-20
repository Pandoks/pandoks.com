---
paths:
  - '**/*.sh'
  - 'scripts/**'
  - '**/Dockerfile'
  - '**/entrypoint.sh'
  - '**/cloud-config.yaml'
---

# Code style — POSIX shell

Mechanical formatting is shfmt + shellcheck (`.editorconfig` enforces POSIX
variant, `binary_next_line`, `switch_case_indent`, `space_redirects`, no
`simplify`-via-minify). The project-specific taste:

## File header

- **`#!/bin/sh` only on `main.sh`** (`scripts/cluster/main.sh:1`).
- **Every sourced library starts with `# shellcheck shell=sh`** and contains
  only function definitions — no `set -eu`, no top-level state.
  Confirmed: `scripts/lib/font.sh:1`, `scripts/lib/sst.sh:1`,
  `scripts/lib/template.sh:1`, `scripts/lib/kubernetes.sh:1`,
  `scripts/lib/log.sh:1`, `scripts/lib/os.sh:1`,
  `scripts/cluster/usage.sh:1`, `scripts/cluster/k3d.sh:1`,
  `scripts/cluster/deploy.sh:1`.
- **`scripts/lib/` library inventory** (what each sourced lib provides):
  - `font.sh` — ANSI color consts (`${RED}` … `${NORMAL}`, `:5-11`).
  - `log.sh` — `log_error`/`log_ok`/`log_warn` + `die` (`log_error` then
    `exit 1`).
  - `os.sh` — `get_os`/`get_package_manager`/`get_shell`/
    `get_shell_rc_file` + their `is_supported_*` guards.
  - `template.sh` — `${VAR | filter}` substitution
    (`template_substitute()` `:32`, `apply_template_filter_to_value()`
    `:9`, `yaml_safe_value()` `:3`).
  - `sst.sh` — `get_sst_resources()` (`:3`) → runs
    `pnpm sst shell [--stage X] node scripts/lib/sst-resources.ts`.
  - `kubernetes.sh` — `wait_for_crd()` (`:3`, polls `kubectl get crd`
    with timeout) + `validate_and_get_absolute_kubeconfig_path()` (`:21`).

## Function-prefixed locals

POSIX sh has no `local`, so every helper prefixes its variables with the
function name to dodge global pollution:

- `cmd_deploy_compute_vars_env` (`scripts/cluster/deploy.sh:11`).
- `cmd_deploy_compute_vars_image_registry`
  (`scripts/cluster/deploy.sh:17`).
- `cmd_k3d_up_k3s_version` (`scripts/cluster/k3d.sh:23`).
- `template_substitute_pattern_content` (`scripts/lib/template.sh:43`).

Verbose, but necessary.

## Help-by-default dispatchers

- Zero-arg invocation prints usage and exits via `usage <code>`; never
  run-all on bare invocation. **No `all` subcommand.**
  See `scripts/cluster/main.sh:19`, `scripts/cluster/deploy.sh:129`,
  `scripts/cluster/k3d.sh:106`.
- **No exceptions** — `scripts/bootstrap/main.sh` is help-by-default too
  (`usage 0` on zero args, `bootstrap/main.sh:44`; it does have an `all`
  subcommand). Unattended callers pass the subcommand explicitly: the
  Claude Code SessionStart hook execs `main.sh all`
  (`.claude/hooks/startup.sh:3`). The decision rule: dispatchers never
  guess — anything automated spells out what it wants.

## Status output

- **`log_status`** at `scripts/cluster/deploy.sh:5-8` — `printf` to stderr,
  gated by `QUIET` flag set by `--quiet`/`-q`
  (`scripts/cluster/deploy.sh:173-175`).

## ANSI colors

- **From `scripts/lib/font.sh:5-11`**: `${RED}`, `${GREEN}`, `${YELLOW}`,
  `${BOLD}`, `${NORMAL}`.
- Use `printf`, **not** `echo`, for anything with formatting.
  Canonical error line:
  `printf "%bError:%b ...\n" "${RED}" "${NORMAL}" >&2` — now wrapped in
  the shared `log_error()` helper (`scripts/lib/log.sh:4`) + `die()`
  (`scripts/lib/log.sh:15`, which `log_error`s then `exit 1`s). Callers
  use the helpers, e.g. `scripts/cluster/deploy.sh:57, 137, 177, 191`
  (`log_error`) and `:157, 164` (`die`). The raw inline form survives
  only in libraries that predate the helper
  (`scripts/lib/{template,kubernetes,os}.sh`).

## Confirmation prompts for destructive ops

```sh
printf "%bDeploy %s to cluster: %s%b [y/n] " "${BOLD}" "${env}" "${ctx}" "${NORMAL}"
read -r response
[ "${response}" != "y" ] && return 0
```

See `scripts/cluster/deploy.sh:198-208`.

## Arg validation

- **Validate args at top of every subcommand**, error to stderr + exit 1
  if unknown (`scripts/cluster/deploy.sh:136-140`,
  `scripts/cluster/k3d.sh:119-122`).

## Comment policy

- File headers only when the file isn't self-evident.
- Function headers (Globals / Arguments / Outputs / Returns) only when
  the signature isn't clear. Example: `scripts/lib/template.sh:25-31`
  documents `template_substitute()` because its filter syntax isn't
  obvious.
