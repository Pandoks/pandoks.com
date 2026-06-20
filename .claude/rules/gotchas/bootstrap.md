# Gotchas — scripts/bootstrap/ (dependency installer)

`pnpm bootstrap all` is the machine bootstrap (macOS/Ubuntu/Arch). It writes
per-developer state to `$HOME`, including a literal AWS config. The same
script also backs the Claude Code SessionStart hook
(`.claude/hooks/startup.sh` execs `main.sh all`), so it runs in Claude Code
Cloud too — see the shims row and the `cmd_setup_all` env-file block below.

## mise owns every version-shaped tool

- `cmd_setup_all` = `ensure_package_manager` → `install_mise` → a
  fork/join: `install_mise_tools` (`mise trust` + `mise install`
  against the root `mise.toml`; downloads direct, no brew/apt) runs
  **concurrently** with the package-manager track
  (`install_swift_format` → `install_docker` → `install_system_tools`
  — serialized among themselves; dpkg/brew locks don't tolerate
  concurrent invocations), `install_aws_config` (pure file write) runs
  inline. Track logs buffer to temp files and replay in order; either
  track failing fails setup. Measured on fresh ubuntu:24.04: 65s
  sequential → 45s concurrent.
- **`mise.toml` is the single tool declaration — every entry an exact
  pinned literal**, never `latest` (floating pins are non-reproducible
  and bypass Renovate's `minimumReleaseAge` cooldown). **Renovate bumps
  them via its native `mise` manager** (the old
  HELM_VERSION/azure-setup-helm regex managers were deleted from
  `renovate.json`). Two pins are bootstraps with an external authority:
  **go** — `go.work`'s directive rules; `GOTOOLCHAIN=auto` makes any go
  binary auto-run the version go.work demands, so mise-pin drift is
  harmless. **kubectl** — the prod pin is `KUBECTL_VERSION` in
  `packages/argocd/Dockerfile` (Renovate's Dockerfile customManager
  bumps it; the `KUBECTL_SHA256` line is updated BY HAND on the PR
  branch — the failing argocd image build on the PR is the reminder).
  The mise.toml + Dockerfile copies travel in one PR via the
  `groupName: "kubectl"` packageRule, so Renovate keeps them in sync —
  no local skew check.
- **`mise trust` before `mise install` is load-bearing** — mise.toml
  has an `[env]` section, which mise refuses to evaluate from untrusted
  configs. CI sets `MISE_TRUSTED_CONFIG_PATHS` on every mise-action
  step for the same reason.
- **Both wiring modes, per mise's own recommendation: `mise activate`
  for interactive shells, shims for everything else — but the rc gets
  ONLY the activate line.** `install_mise` appends `eval "$(mise
activate zsh|bash)"` (plus a `~/.local/bin` prepend on curl installs,
  for the mise binary itself). Activate re-asserts mise first in PATH
  at every prompt — no later rc prepend (nvm/rbenv/brew) can shadow it
  — and exports `MISE_SHELL` (the check's wiring marker). Outside
  mise-configured dirs, tools fall back to whatever else is on PATH
  (shims delegate to the next PATH entry when no version applies —
  verified; so stray brew/nvm copies behind mise are harmless
  fallbacks, not conflicts). Non-interactive shells (SessionStart hook,
  CI, `su -c`) never read the rc anyway and get shims directly:
  `required_path_dirs` (`env.sh`) lists the shims dir,
  `populate_proper_pathing` prepends it inside `cmd_setup_all`, the
  Claude Code Cloud env-file block writes the same dirs to
  `CLAUDE_ENV_FILE`, and CI uses `jdx/mise-action`. No shims line lives
  in any rc file.
- **pnpm: mise installs a bootstrap, `packageManager` stays the
  authority.** pnpm ≥10 ships `manage-package-manager-versions` (default
  on): any pnpm self-switches to the version pinned (with integrity SHA)
  in `package.json`'s `packageManager` — verified: a mise pnpm 11.2.2
  run in-repo reports 11.5.1. So the mise pin is only a bootstrap and
  can't meaningfully drift. This replaces corepack, which is REMOVED
  from node 25+ (bundled only through node 24). pnpm is listed BEFORE
  node in mise.toml so its dir precedes node's corepack shim on PATH.
- **swift-format is NOT in the mise registry** (verified 2026-06-11) —
  it's a brew formula, installed by `install_swift_format` (macOS-only;
  iOS development requires Xcode anyway). If it ever lands in the
  registry, fold it into mise.toml and delete that installer.

## AWS config is hardcoded to Pandoks\_ org

- `install_aws_config` (`scripts/bootstrap/install.sh`) writes a literal
  `~/.aws/config` with the `[sso-session Pandoks_]` block + 3 hardcoded
  profiles (`Personal`/`tzugi-production`/`tzugi-dev`) and 3 hardcoded
  `sso_account_id` values. The awscli binary itself comes from mise.
- **Skip-if-exists**: if `~/.aws/config` already exists and is
  non-empty (`[ -s … ]` check), the function logs a single `log_ok`
  line and returns without touching the file. To re-apply the committed
  template you must delete/move the existing file manually. No merging
  (INI merging in POSIX sh is painful).
- **If you change AWS Identity Center org, rotate the SSO start URL,
  rename a profile, change an account ID, or onboard a new
  account/profile, you MUST update the `install_aws_config` heredoc to
  match.** Existing users won't auto-pick up the change
  (skip-if-exists), but new contributors inherit whatever's committed.
- The SSO start URL (`https://pandoks.awsapps.com/start`) and
  `sso-session Pandoks_` name are hardcoded twice: in the heredoc here,
  and in `package.json`'s `pnpm sso` script. **Both have to change
  together.**

## What's safe in the committed config

- AWS account IDs and SSO start URLs are non-secret metadata, not
  credentials. Anyone running setup needs an Identity Center invite
  before the profiles work.
- Secret material (access keys, session tokens) goes to
  `~/.aws/credentials` and `~/.aws/sso/cache/`; neither is ever written
  by `pnpm bootstrap`.

## Setup script file layout

Sourced in `main.sh` in order: `env.sh` before `install.sh` (the
installers call `ensure_package_manager` and `append_shell_rc`; the
check calls `required_path_dirs`).

| File            | Contains                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.sh`       | Dispatcher + `use_sudo`, `log_step`, `install_packages` (the trivial helpers)                                                                                                                                                                                                                                  |
| `usage.sh`      | Help text (3 commands: `all` (default), `check`, `help`)                                                                                                                                                                                                                                                       |
| `env.sh`        | `append_shell_rc`, `ensure_package_manager`, `fetch_pgp_key`, `required_path_dirs` (mise shims + `~/.local/bin`), `populate_proper_pathing` |
| `install.sh`    | `install_mise`, `install_mise_tools`, `install_swift_format`, `install_docker`, `install_system_tools` (openssl/htpasswd), `install_aws_config`, `maybe_reload_shell` (post-install hint / `--reload` exec), `cmd_setup_all` (`--reload` parse + concurrent fork/join + cloud env-file write)                  |
| `check.sh`      | `check_report` + `mise_bin` + `cmd_setup_check`                                                                                                                                                                                                                                                                |
| `next-steps.sh` | `print_next_steps` + `show_bootstrap_header` — bootstrap todos + OS reminders                                                                                                                                                                                                                                  |

## CLI surface

Only three subcommands exist: `all` (`--reload`), `check`, `help`.
Per-tool subcommands were removed intentionally — surface bloat was the
original problem. Bare invocation prints help and exits 0, same as
every other dispatcher in the repo (the former default-to-`all`
exception was removed); the SessionStart hook passes `all` explicitly
(`.claude/hooks/startup.sh`).

## The npm script is `bootstrap`, NOT `setup` (pnpm builtin collision)

`package.json:12` names the script **`bootstrap`** → `pnpm bootstrap
all`. It is NOT named `setup` because **pnpm ships a builtin
`pnpm setup` command** (configures pnpm's own home dir) that shadows a
same-named script for ANY argument — verified on pnpm 11.5.1: with a
`"setup"` script present, `pnpm setup all` silently ran the *builtin*
(`Already up to date … using pnpm v11.5.1`), never the script, and
`pnpm setup all --reload` hard-errored `Unknown option: 'reload'` from
pnpm's own parser. `pnpm run setup …` would force the script, but the
bare form is the trap. A non-colliding name (`bootstrap`) passes every
arg straight through — `pnpm bootstrap all --reload` works with no
`run`, no `--`. **Don't rename it back to `setup`.** (The script
*directory* is `scripts/bootstrap/` — renamed from `scripts/setup/`
in lockstep with the npm script.)

## `all` post-install shell wiring (a child can't reload its parent)

`install_mise` appends the `mise activate` line on a fresh wire and sets
`SETUP_MISE_RC_ADDED=1` (`append_shell_rc` returns 0 only when it
actually wrote). At the very end `cmd_setup_all` calls
`maybe_reload_shell`:

- **Default** — if the rc was just wired, print the one-liner
  (`eval "$(mise activate <shell>)"`) to load mise into the CURRENT
  shell. A child process CANNOT mutate its parent's env, so this is a
  hint, not an action — same wall mise's own installer hits.
- **`--reload`** — `exec "$SHELL" -l` to replace the process with a
  fresh login shell so mise is live immediately. **Guarded to
  interactive ttys** (`[ -t 0 ] && [ -t 1 ]`): under the SessionStart
  hook or CI (no tty) it silently falls back to the hint, so a login
  shell never hangs waiting for input. Verified in Docker: non-tty
  `--reload` skips the exec and prints the hint.
- **Re-run / already wired** — `SETUP_MISE_RC_ADDED=0`, so
  `maybe_reload_shell` is a no-op (no hint, no reload).

`exec` must be the LAST thing `cmd_setup_all` does (it never returns) —
it sits after the Claude Code Cloud env-file block.

## `setup check` semantics

`cmd_setup_check` trusts mise for versions and audits everything mise
can't see. Five sequential checks (~0.1s total, no per-tool version
probes):

1. **mise + wiring on PATH** — `mise_bin` finds the binary even off
   PATH (via `required_path_dirs`) so the report can say `⚠ installed
at <dir> — not on PATH (source your rc)` instead of `✗ not
installed`. Wiring counts as either the shims dir string-matched in
   `$PATH` or `MISE_SHELL` set (`mise activate` strips the shims dir
   and prepends real tool dirs, so activate'd shells pass via the env
   marker).
2. **Pinned tools installed** — one `mise ls --current` (run from
   `REPO_ROOT`, captured once); missing rows carry `(missing)` in
   field 3 (`awk '$3 == "(missing)"'`), and the same capture provides
   the tool count — no second mise call. Each missing tool is a `✗`.
   On Linux, `cocoapods` is filtered out (macOS-gated in the mise
   registry — never installed there, verified in the Ubuntu container
   test).
3. **Shadow sweep** — every entry in the shims dir must resolve via
   mise (its own shim, or a `…/mise/installs/…` path in activate'd
   shells). A tool that resolves elsewhere is flagged only if
   `mise which <name>` says mise provides it here (filters out
   other-project shims in activate mode) → `✗ shadowed: <name>
resolves to <path>`. Skipped when unwired (everything would be
   noise). **This is the check's whole reason to exist independently
   of `mise ls`** — mise's own view is green even when PATH
   resolution is broken.
4. **Non-mise tools, presence-only** — docker/openssl/htpasswd, plus
   swift-format on Darwin only.

`⚠` and `✗` both exit non-zero. The old per-tool version-drift probes
(node/pnpm/go/aws/helm/kubectl) were all deleted deliberately: with
mise as the installer, "right version installed" is `mise ls`'s job,
"right version resolves" is the shadow sweep's job, go/pnpm
self-correct at runtime (GOTOOLCHAIN / `packageManager`), and the
mise.toml/Dockerfile kubectl pair is kept in sync by Renovate's
`kubectl` group PR — so the check does no version comparison at all.

## Bumping the prod kubectl pin is NOT a one-line edit

You must edit BOTH `KUBECTL_VERSION` and `KUBECTL_SHA256` in
`packages/argocd/Dockerfile` — the SHA is verified by `sha256sum -c`.
Renovate bumps the version (the `kubectl` group PR, which also carries
the mise.toml pin) but cannot compute binary checksums — and because
`build-and-publish.yaml` runs on every branch push, **the stale SHA
fails the argocd image build right on the PR**, so the red check is the
reminder. Fix: fetch the published checksum and push to the PR branch:
`curl -fsSL https://dl.k8s.io/release/v<NEW>/bin/linux/amd64/kubectl.sha256`.
A minor
bump can also invalidate the kubectl CVE suppressions in
`.trivyignore.yaml` — re-review those entries after bumping.

## Don't use `api.github.com` for version discovery

It rate-limits unauthenticated requests at 60/hour per IP and 403s on
shared-egress hosts (Claude Code Cloud, CI runners). mise's aqua
backend ships its own metadata + checksums, which is why tool installs
don't hit this. If you add a bespoke "get latest version" lookup,
prefer a vendor CDN plain-text endpoint — but prefer a pin in
`mise.toml` over discovery entirely.

## `ensure_package_manager` writes to stderr

`env.sh` wraps the apt/pacman/brew bootstrap chatter in `{ … } 1>&2` so
callers can safely do `pm=$(ensure_package_manager)` and capture
**only** the PM name. **Don't unwrap the redirect.**
