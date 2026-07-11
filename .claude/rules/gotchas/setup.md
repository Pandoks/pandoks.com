# Gotchas — scripts/setup/ (dependency installer)

`pnpm setup` is the machine bootstrap (macOS/Ubuntu/Arch). It writes
per-developer state to `$HOME`, including a literal AWS config. The same
script also backs the Claude Code SessionStart hook
(`.claude/hooks/startup.sh` execs `main.sh`), so it runs in Claude Code
Cloud too — see the `env.sh` PATH-population row and the `cmd_setup_all` env-file block below.

## AWS config is hardcoded to Pandoks\_ org

- `scripts/setup/install.sh:202-235` (the config half of
  `install_aws`, which also does the awscli-v2 install) writes
  a literal `~/.aws/config` with the `[sso-session Pandoks_]` block + 3
  hardcoded profiles (`Personal`/`tzugi-production`/`tzugi-dev`) and 3
  hardcoded `sso_account_id` values (`install.sh:217, 223, 229`).
- **Skip-if-exists**: if `~/.aws/config` already exists and is
  non-empty (`[ -s … ]` check at `install.sh:202`), the function
  logs a single `log_ok` line and returns without touching the file.
  To re-apply the committed template you must delete/move the existing
  file manually. No merging (INI merging in POSIX sh is painful).
- **If you change AWS Identity Center org, rotate the SSO start URL,
  rename a profile, change an account ID, or onboard a new
  account/profile, you MUST update the `install_aws` config heredoc to match.**
  Existing users won't auto-pick up the change (skip-if-exists),
  but new contributors running `pnpm setup` on a fresh machine
  will inherit whatever's committed — so the committed template
  has to stay accurate.
- The SSO start URL (`https://pandoks.awsapps.com/start` at
  `install.sh:212`) and `sso-session Pandoks_` name are hardcoded
  twice: in the heredoc here, and in `package.json:11`'s `pnpm sso`
  script (`aws sso login --sso-session=Pandoks_ …`). **Both have to
  change together** — they're load-bearing for `pnpm sso` to work
  after setup.

## What's safe in the committed config

- AWS account IDs and SSO start URLs are non-secret. They're
  metadata, not credentials. Anyone running the setup script needs
  to be invited to the Identity Center before any of these profiles
  actually work — the config is just a label mapping.
- Secret material (access keys, session tokens) goes to
  `~/.aws/credentials` and `~/.aws/sso/cache/` respectively; neither
  is ever written by `pnpm setup`.

## Setup script file layout

`scripts/setup/` is split by concern (see `conventions/shell.md` for the
general pattern where `main.sh` keeps the dispatcher plus trivial
helpers). Sourced in `main.sh` in order: `env.sh` before `install.sh`,
since `cmd_setup_all` calls `populate_proper_pathing` (and reuses
`required_path_dirs` for its cloud env-file block) and the installers/check
call the pinned-version parsers (`read_nvmrc`, `pnpm_spec`,
`kubectl_pinned_minor`, `go_required_version`):

| File            | Contains                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.sh`       | Dispatcher + `use_sudo`, `log_step`, `install_packages` (the trivial helpers)                                                                                                                                                                                                                                    |
| `usage.sh`      | Help text (3 commands: `all` (default), `check`, `help`)                                                                                                                                                                                                                                                         |
| `env.sh`        | `append_shell_rc`, `ensure_package_manager`, `fetch_pgp_key`, the pinned-version parsers (`read_nvmrc`, `pnpm_spec`, `kubectl_pinned_minor`, `go_required_version`), `required_path_dirs`, `populate_proper_pathing` (prepend tool dirs to live PATH so installer short-circuits don't reinstall)                |
| `install.sh`    | `HELM_VERSION` pin + shared helpers (`detect_architecture`, `architecture_asset`, `all_tools_present_in_path`, `install_helm`, `install_k3d`, `install_hadolint`) + every `install_<tool>` installer (`install_node/python/go/aws/docker/kubernetes/quality`) + `cmd_setup_all` (incl. the cloud env-file write) |
| `check.sh`      | `check_major_match` + `version_drift` + `print_check_report_status` + `cmd_setup_check`                                                                                                                                                                                                                          |
| `next-steps.sh` | `print_next_steps` + `show_bootstrap_header` — bootstrap todos + OS reminders                                                                                                                                                                                                                                    |

## CLI surface

Only three subcommands exist: `all` (the default when invoked without
args — see `main.sh:44`), `check`, `help`. Per-tool subcommands
(`node`, `python`, `go`, `aws`, `docker`, `kubernetes`, `quality`) were
removed intentionally; the underlying `install_<tool>` functions still
exist as internal callees of `cmd_setup_all` but are NOT user-facing.
Don't re-add subcommands without a concrete reason — surface bloat was
the original problem.

## Speed: fast-path short-circuits, check is on-demand

- **`cmd_setup_all` does NOT run `cmd_setup_check`** (`install.sh:387`).
  Earlier versions gated the version inventory behind a
  `SETUP_INSTALLED_*` flag cluster; that machinery was removed because
  it protected a re-run optimization that was never wired up (the
  SessionStart hook swallowed the exit code). `setup check` is now a
  separate on-demand subcommand. Each installer self-short-circuits via
  its own `command -v` / version probe at the top, so a warm `setup`
  run skips the install work without any global flag.
- **Each installer fast-paths individually** — `install_node` checks for
  the `.nvmrc`-matching node bin dir on disk (`install.sh:60-65`) before
  the expensive nvm.sh sourcing; `install_kubernetes`/`install_quality`
  use `all_tools_present_in_path` (`install.sh:285, 337`); the cluster
  fast-path is also **version-aware** for the pinned tools (helm,
  kubectl) via `version_drift`, so a wrong-major helm triggers reinstall
  instead of being skipped (`install.sh:285-289`).
- **`SETUP_PACKAGE_MANAGER_CACHE`** at `env.sh:30` caches the
  detected PM name so `ensure_package_manager` only runs
  apt-update / pacman -Syu / Xcode-CLT / Homebrew bootstrap once per
  run, not per-installer.
- **`SETUP_PATH_DIRS_CACHE`** at `env.sh:140` memoizes
  `required_path_dirs` the same way (gate-at-top, mirrors the PM cache).
  Deterministic within a run (check is read-only — no installs, no PATH
  mutation). The main beneficiary is `populate_proper_pathing` in
  `cmd_setup_all`, which calls `required_path_dirs` in the single main
  process. **Inside `setup check` the cache is per-subshell**: the 19
  probes run as backgrounded (`&`) subshells, and a shell var set in a
  subshell can't propagate back to the parent or siblings — so each
  off-PATH probe recomputes its own copy (the first call in each subshell
  pays `go env GOPATH`). Not primed before the fan-out by design — the
  per-subshell recompute is cheap enough and check stays sub-second.
- **No `~/.cache/pandoks-setup/`** — explicitly chose not to ship
  on-disk caches after trying them in worktrees. The in-memory
  short-circuits get warm runs sub-second; the extra wasn't worth a
  cache-invalidation surface.
- **`cmd_setup_check` is parallel** (`check.sh:114`) — 19 `command -v` +
  version probes fan out via `&` + `wait` (`check.sh:140-144`), each
  writing to its own numbered temp file via `print_check_report_status`,
  then cat'd in order. Drift is derived from the report content (a `✗`
  **or `⚠`** line via `grep`, `check.sh:149`), not a separate marker
  file — a marker written after the report could be lost if the
  backgrounded subshell died in between, silently downgrading drift to OK.
- **`setup check` is 3-state, not 2** (`print_check_report_status`,
  `check.sh:73-112`). For each tool: on PATH + in-spec → `✓`; on PATH +
  wrong version → `✗ … (want …)` (drift, `version_drift`); \*\*not on the
  live PATH but found in one of `required_path_dirs` → `⚠ installed at
  <dir> — not on PATH (source your rc)`**; nowhere → `✗ not installed`.
  The `⚠` state exists because a **non-interactive** shell (CI, the
  SessionStart hook, `su -c`) never sources the rc the installer wrote,
  so user-dir tools (nvm node, `/usr/local/go/bin`, `~/go/bin`,
  `~/.local/bin`) are installed but off-PATH. **`⚠` still exits
  non-zero** — off-PATH means "not usable in this shell" — it only
  changes the message (source-your-rc vs reinstall). The off-PATH probe
  runs in a `$(…)` subshell, so `check` never mutates the live PATH (it
  reports honest current-shell truth); it does NOT call
  `populate_proper_pathing` the way `cmd_setup_all` does.

## Pinned versions to keep in sync with prod

- **kubectl minor** is derived from the prod cluster pin
  (`KUBECTL_VERSION` at `packages/argocd/Dockerfile:26`) — NOT
  hardcoded. `kubectl_pinned_minor` (`env.sh:131-134`) parses the
  `MAJOR.MINOR` out of it; both the apt-repo channel
  (`install.sh:307, 311`) and the drift check consume that one value, so
  the **setup script** follows the Dockerfile automatically. The
  `version_drift` kubectl case (`check.sh:54-69`) flags drift
  when the installed minor falls outside kubectl's ±1-minor support
  envelope around the pin. Only the apt arm is channel-pinned to the
  minor; brew/pacman install latest kubectl (the ±1 envelope + drift
  check absorb the normal gap).
  - **Bumping the prod kubectl pin is NOT a one-line edit.** You must
    edit BOTH `KUBECTL_VERSION` (`Dockerfile:26`) **and**
    `KUBECTL_SHA256` (`Dockerfile:27`) — the SHA is verified by
    `sha256sum -c` at `Dockerfile:29`; a stale SHA breaks the argocd
    image build. Renovate auto-bumps the version via the customManager
    (`renovate.json:26-34`) but **cannot compute the binary checksum**
    (`renovate.json:28`), so its PR always needs a manual SHA edit.
  - A minor bump also changes the Go toolchain kubectl is built on,
    which can invalidate the kubectl CVE suppressions in
    `.trivyignore.yaml` (currently scoped to `release-1.36`/Go-1.26.4/x-net-0.49.0,
    `expired_at: 2026-08-12`) — re-review those entries after bumping.
- **`.nvmrc`** is the source of truth for Node version, read via the
  shared `read_nvmrc` helper (`env.sh:122-124`, `tr -d '[:space:]'`) —
  consumed by `install_node` (`install.sh:57`), `required_path_dirs`,
  and the node drift check. No second copy of the parse logic.
- **`packageManager` in `package.json:4`** is the source of truth
  for pnpm version + integrity SHA. The `pnpm_spec` helper
  (`env.sh:126-129`) parses the `pnpm@<ver>` spec out of it and
  `install_node` passes it EXPLICITLY to `corepack prepare "${2}" --activate`
  (`install.sh:101`) — a bare `corepack prepare --activate` needs a
  `package.json` in CWD, which the SessionStart hook can't guarantee.
- **Go version** is the `go` directive in `go.work` (the same source
  CI's `setup-go` reads via `go.mod`). `go_required_version`
  (`env.sh:136-138`) parses it. On apt the official `go.dev` tarball is
  fetched (apt's `golang-go` lags — Ubuntu 24.04 ships 1.22, below the
  directive) (`install.sh:148-161`); brew/pacman use the current native
  package. The `version_drift` go case (`check.sh:35-53`) flags an
  installed go below the required version — patch-aware when the
  directive pins one, since go.work patch bumps are usually stdlib
  CVE fixes. Renovate keeps `go.work`,
  `go.mod`, and the valkey Dockerfile in sync (grouped via `allNonMajor`).
- **helm is pinned to a literal `HELM_VERSION`** (`install.sh:3-4`,
  Renovate-annotated; a customManager in `renovate.json` reads the
  inline `# renovate:` comment). Unlike kubectl there's no upstream
  container to read it from, and CI's `azure/setup-helm` `with: version:`
  can't read a shell var — so the pin is a literal in **three places
  that MUST change in lockstep**: `HELM_VERSION` (`install.sh:4`),
  `version:` in `.github/workflows/checks.yaml`, and `version:` in
  `.github/workflows/build-and-publish.yaml` (the last two each carry a
  `# renovate:` comment so a Renovate customManager bumps them too).
  Both apt and pacman arms install via the shared `install_helm`
  (`install.sh:29-38`, pinned `get.helm.sh` tarball) — pacman doesn't
  use distro `helm`, for deterministic pinning (Arch's helm happens to
  be 4.x too, but rolling so it'd drift). The `version_drift` `helm)`
  case (`check.sh:24-29`) flags drift when the installed major ≠
  `HELM_VERSION`'s major. **macOS uses `brew install helm` (the
  `install_kubernetes` brew arm), NOT the pinned tarball — so mac is
  structurally unpinned and can drift a minor; the major-only drift
  check won't flag it.** **Bumping helm = edit all three literals + let
  Renovate's PR drive it.**

## Decommissioned upstream surfaces

- **`baltocdn.com/helm/signing.asc` returns HTTP 204 / empty body**
  — the Helm apt repo was decommissioned. `install_helm`
  (`install.sh:29-38`) uses the official `get.helm.sh` tarball
  instead. **Don't try to revive the apt repo path** — the upstream
  URL is alive but no longer serves a key.
- **Don't use `api.github.com` for version discovery.** It
  rate-limits unauthenticated requests at 60/hour per IP and 403s
  on shared-egress hosts (Claude Code Cloud, CI runners). helm is
  now pinned (no runtime version discovery — see the Pinned-versions
  section); the old `https://get.helm.sh/helm-latest-version`
  lookup was removed because an unbounded "latest" silently jumped
  the major across machines. If you add a new "get latest version"
  lookup, prefer a vendor CDN plain-text endpoint over the GitHub
  API — but prefer a pin over discovery entirely.
- **`hadolint` is not in apt and is AUR-only on Arch** — so on every
  Linux it's installed via the `install_hadolint` helper
  (`install.sh:46-53`, GitHub-release binary). **The apt and pacman
  arms of `install_quality` are SEPARATE** (pacman arm
  `install.sh:356`, apt arm `install.sh:367`; the linters go-install as
  `github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest` etc.
  on apt, native `pacman -S golangci-lint actionlint govulncheck` on Arch),
  not shared: Arch is rolling, so `pacman` installs the linters
  (`actionlint`, `golangci-lint`, `govulncheck`) and `uv`/`aws-cli-v2`
  natively; apt lacks them, so apt go-installs the linters + uses the
  astral/AWS-bundle installers. The same split applies in
  `install_python` (uv) and `install_aws` (aws). Brew has all the
  quality tools as first-party formulae. **When editing a Linux install
  path, check WHICH arm — apt and pacman now diverge.**

## nvm + POSIX sh interaction

- `nvm.sh` is **bash-only** and uses constructs that trip `set -e`.
  `install.sh:95-102` calls it from a `bash -c` subshell **without**
  `set -e`; each step is guarded with a distinct `|| exit N` instead.
  **Don't add `set -e` to that bash block** — sourcing `nvm.sh`
  legitimately returns non-zero on its last internal command, and
  `set -e` aborts the install at the source line (verified: it breaks
  node install on a clean machine).

## `ensure_package_manager` writes to stderr

`env.sh:42-86` wraps the apt/pacman/brew bootstrap chatter in
`{ … } 1>&2`. This is so callers can safely do
`pm=$(ensure_package_manager)` to capture **only** the PM
name (`apt-get`/`pacman`/`brew`) — without this redirect, the
captured variable gets ~40 KB of `Setting up …` apt output.
**Don't unwrap the redirect.**

## Version checks are inconsistent across installers

The per-installer short-circuit (`command -v <tool>`) accepts any
version. The real version enforcement lives in `version_drift`
(`check.sh:12-71`), which pins six tools:

- **node** — major must match `.nvmrc`.
- **pnpm** — major must match `package.json`'s `packageManager`.
- **go** — must be `>=` the `go.work` directive; when the directive
  pins a patch, an equal-minor install must also meet the patch.
- **aws** — must be `aws-cli/2.*` (rejects v1, accepts any v2.x).
- **helm** — major must match `HELM_VERSION` (`install.sh:4`).
- **kubectl** — minor must be within ±1 of the prod cluster pin
  (`KUBECTL_VERSION` in `packages/argocd/Dockerfile`, read via
  `kubectl_pinned_minor`). Catches e.g. a stale `kubectl v1.30`
  from an old Homebrew install against a v1.36 cluster.

The node/pnpm/helm cases share `check_major_match` (`check.sh:3-10`).
Every other tool (uv, docker, k3d, kubeconform, jq, openssl, htpasswd,
the linters/formatters) is presence-only — no project pin exists to
drift against, so `command -v` is the only meaningful signal.
`cmd_setup_check` returns non-zero on any missing/drifted tool. The
cluster installer fast-path (`install_kubernetes`) ALSO calls
`version_drift` on helm + kubectl, so a drifted pinned tool triggers
reinstall rather than being skipped. **If you start pinning a new tool,
add its case to `version_drift` — the installer short-circuit alone
won't catch drift.**
