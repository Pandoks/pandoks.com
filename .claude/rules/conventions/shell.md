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
- **Every sourced helper starts with `# shellcheck shell=sh`** and has no
  `set -eu`. Confirmed: `scripts/lib/{font,log,sst,template}.sh:1` and
  `scripts/cluster/{usage,k3d,deploy}.sh:1`.
- **`scripts/lib/` library inventory** (what each sourced lib provides):
  - `font.sh` — ANSI formatting constants (`:5-12`).
  - `log.sh` — `log_error`/`log_ok`/`log_warn` + `die` (`log_error` then
    `exit 1`).
  - `sst.sh` — reusable SST resource loading through `get_sst_resources()`.
  - `template.sh` — `${VAR | filter}` substitution
    (`template_substitute()` `:32`, `apply_template_filter_to_value()`
    `:9`, `yaml_safe_value()` `:3`).

Cluster-only helpers stay with their sole consumer: `k3d.sh` owns Docker
Compose dependency commands; `deploy.sh` owns CRD waiting and kubeconfig
validation. SST helpers remain in `scripts/lib/sst.sh` for reuse outside
cluster deployment.

## Function-prefixed locals

POSIX sh has no `local`, so every helper prefixes its variables with the
function name to dodge global pollution:

- `cmd_deploy_compute_vars_env` (`scripts/cluster/deploy.sh:24`).
- `cmd_deploy_compute_vars_image_registry`
  (`scripts/cluster/deploy.sh:29`).
- `cmd_k3d_up_k3s_version` (`scripts/cluster/k3d.sh:51`).
- `template_substitute_pattern_content` (`scripts/lib/template.sh:43`).

Verbose, but necessary.

## Help-by-default dispatchers

- Zero-arg invocation prints usage and exits via `usage <code>`; never
  run-all on bare invocation. **No `all` subcommand.**
  See `scripts/cluster/main.sh:18`, `scripts/cluster/deploy.sh:141`,
  `scripts/cluster/k3d.sh:135`.

## Status output

- **`log_status`** at `scripts/cluster/deploy.sh:5-8` — `printf` to stderr,
  gated by `QUIET` flag set by `--quiet`/`-q`
  (`scripts/cluster/deploy.sh:187-189`).

## ANSI colors

- **From `scripts/lib/font.sh:5-12`**: `${BOLD}`, `${NORMAL}`, `${RED}`,
  `${GREEN}`, `${YELLOW}`, `${BLUE}`, and `${CYAN}`. Blue and cyan are
  reserved for future status styles.
- Use `printf`, **not** `echo`, for anything with formatting.
  Canonical error line:
  `printf "%bError:%b ...\n" "${RED}" "${NORMAL}" >&2` — now wrapped in
  the shared `log_error()` helper (`scripts/lib/log.sh:4`) + `die()`
  (`scripts/lib/log.sh:15`, which `log_error`s then `exit 1`s). Callers
  use the helpers, e.g. `scripts/cluster/deploy.sh:70, 150, 193, 207`
  (`log_error`) and `:16, 170, 177, 180` (`die`). The raw inline form
  survives only in `scripts/lib/template.sh`, which predates the helper.

## Confirmation prompts for destructive ops

```sh
printf "%bDeploy %s to cluster: %s%b [y/n] " "${BOLD}" "${env}" "${ctx}" "${NORMAL}"
read -r response
[ "${response}" != "y" ] && return 0
```

See `scripts/cluster/deploy.sh:211-222`.

## Arg validation

- **Validate args at top of every subcommand**, error to stderr + exit 1
  if unknown (`scripts/cluster/deploy.sh:146-153, 192-195`,
  `scripts/cluster/k3d.sh:140-151`).

## Comment policy

- File headers only when the file isn't self-evident.
- Function headers (Globals / Arguments / Outputs / Returns) only when
  the signature isn't clear. Example: `scripts/lib/template.sh:25-31`
  documents `template_substitute()` because its filter syntax isn't
  obvious.
