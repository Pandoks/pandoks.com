# Gotchas — scripts/setup/ (dependency installer)

`pnpm setup` is the local-machine bootstrap (macOS/Ubuntu/Arch). It is
NOT shared infrastructure — it writes per-developer state to `$HOME`,
including a literal AWS config.

## AWS config is hardcoded to Pandoks\_ org

- `scripts/setup/packages.sh:151-188` (`cmd_setup_aws_config`) writes
  a literal `~/.aws/config` with the `[sso-session Pandoks_]` block + 3
  hardcoded profiles (`Personal`/`tzugi-production`/`tzugi-dev`) and 3
  hardcoded `sso_account_id` values (`packages.sh:170, 176, 182`).
- **Skip-if-exists**: if `~/.aws/config` already exists and is
  non-empty (`[ -s … ]` check at `packages.sh:155`), the function
  logs a single `log_ok` line and returns without touching the file.
  To re-apply the committed template you must delete/move the existing
  file manually. No merging (INI merging in POSIX sh is painful).
- **If you change AWS Identity Center org, rotate the SSO start URL,
  rename a profile, change an account ID, or onboard a new
  account/profile, you MUST update `cmd_setup_aws_config` to match.**
  Existing users won't auto-pick up the change (skip-if-exists),
  but new contributors running `pnpm setup all` on a fresh machine
  will inherit whatever's committed — so the committed template
  has to stay accurate.
- The SSO start URL (`https://pandoks.awsapps.com/start` at
  `packages.sh:165`) and `sso-session Pandoks_` name are hardcoded
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

`scripts/setup/` is five files (split intentional — see
`conventions/shell.md` for the general pattern where `main.sh` keeps
the dispatcher plus trivial helpers):

| File            | Contains                                                                         |
| --------------- | -------------------------------------------------------------------------------- |
| `main.sh`       | Dispatcher + `use_sudo`, `log_step`, `install_packages` (the trivial helpers)    |
| `usage.sh`      | Help text (3 commands: `all` (default), `check`, `help`)                         |
| `env.sh`        | `append_shell_rc`, `cmd_setup_ensure_package_manager`, `cmd_setup_fetch_pgp_key` |
| `packages.sh`   | Every `cmd_setup_<tool>` installer + `cmd_setup_all` + `cmd_setup_check`         |
| `next-steps.sh` | `cmd_setup_print_next_steps` — activation lines + bootstrap todos                |

## CLI surface

Only three subcommands exist: `all` (the default when invoked without
args — see `main.sh:42`), `check`, `help`. Per-tool subcommands
(`node`, `python`, `go`, `aws`, `docker`, `cluster`, `quality`) were
removed intentionally; the underlying functions still exist as
internal callees of `cmd_setup_all` but are NOT user-facing. Don't
re-add subcommands without a concrete reason — surface bloat was the
original problem.

## Speed: in-memory short-circuits, no on-disk caching

- **`SETUP_INSTALLED_NODE` / `_UV` / `_GO`** at `packages.sh:3-5` are
  module-level flags installers set to `1` when they actually
  installed something this run. Read by `cmd_setup_all`'s
  conditional check gate and by `cmd_setup_print_next_steps` —
  re-runs on a fully-bootstrapped machine never flip them, so the
  19-tool version inventory and the activation block both skip.
- **`SETUP_PACKAGE_MANAGER_CACHE`** at `env.sh:30` caches the
  detected PM name so `cmd_setup_ensure_package_manager` only runs
  apt-update / pacman -Syu / Xcode-CLT / Homebrew bootstrap once per
  `setup all`, not per-installer.
- **No `~/.cache/pandoks-setup/`** — explicitly chose not to ship
  on-disk caches (e.g., aws-v2 marker, check-output cache) after
  trying them in worktrees. The in-memory short-circuits get warm
  runs ~1s; the extra ~300ms wasn't worth a cache-invalidation
  surface.
- **`cmd_setup_check` is parallel** — 19 `command -v` + version
  probes fan out via `&` + `wait`, each writing to its own temp
  file, then cat'd in order. ~800ms.

## Pinned versions to keep in sync with prod

- **kubectl apt repo minor** at `packages.sh:260`
  (`cmd_setup_cluster_kube_minor="v1.36"`) must match the version
  used by the prod cluster (`packages/argocd/Dockerfile:20`). When
  the prod kubectl moves, bump this in lockstep — otherwise Ubuntu
  contributors drift outside kubectl's ±1-minor support envelope
  against the cluster.
- **`.nvmrc`** is the source of truth for Node version
  (`packages.sh:8-10` reads it via `tr -d '[:space:]'`). No second
  copy in the installer.
- **`packageManager` in `package.json:4`** is the source of truth
  for pnpm version + integrity SHA. `corepack prepare --activate`
  (`packages.sh:43`) reads it.

## Decommissioned upstream surfaces

- **`baltocdn.com/helm/signing.asc` returns HTTP 204 / empty body**
  — the Helm apt repo was decommissioned. `packages.sh:274-288`
  uses the official `get.helm.sh` tarball instead. **Don't try to
  revive the apt repo path** — the upstream URL is alive but no
  longer serves a key.
- **Don't use `api.github.com` for version discovery.** It
  rate-limits unauthenticated requests at 60/hour per IP and 403s
  on shared-egress hosts (Claude Code Cloud, CI runners). The
  helm install uses `https://get.helm.sh/helm-latest-version`
  (plain-text endpoint, no quota) instead. If you add new
  "get latest version" lookups, prefer vendor CDN endpoints over
  the GitHub API.
- **`hadolint` is not in any major apt/pacman repo** (Arch has it
  in AUR only). `packages.sh:335-345` (Ubuntu) and `:358-368`
  (Arch) install via GitHub releases binary download. Same for
  `actionlint` / `golangci-lint` / `govulncheck` (`go install`).
  Brew has all of them as first-party formulae.

## nvm + POSIX sh interaction

- `nvm.sh` is **bash-only** and uses constructs that trip `set -e`.
  `packages.sh:37-48` calls it from a `bash -c` subshell **without**
  `set -e` and validates by re-checking node/pnpm versions afterwards.
  **Don't add `set -e` to that bash block** — sourcing `nvm.sh`
  legitimately returns non-zero on its last internal command.

## `cmd_setup_ensure_package_manager` writes to stderr

`env.sh:41-85` wraps the apt/pacman/brew bootstrap chatter in
`{ … } 1>&2`. This is so callers can safely do
`pm=$(cmd_setup_ensure_package_manager)` to capture **only** the PM
name (`apt-get`/`pacman`/`brew`) — without this redirect, the
captured variable gets ~40 KB of `Setting up …` apt output.
**Don't unwrap the redirect.**

## Version checks are inconsistent across installers

Only Node does a real version check (`packages.sh:14-20` —
`nvm version "$(cat .nvmrc)"`). Every other installer's
short-circuit is `command -v <tool>` — any version satisfies it.
awscli is a partial exception (matches `aws-cli/2.*`, rejects v1
but accepts any v2.x).

This is mostly fine because tools the script installs itself
(via apt repo / brew formula / `go install`) come at known
versions. But if a user has e.g. `kubectl v1.30` from an old
Homebrew install, our short-circuit accepts it even though we
pin v1.36 in the apt repo to match prod. **Don't assume the
installed tool matches the version we'd install** — add a
real version check only if you've actually hit drift in
practice.
