# Gotchas — scripts/setup/ (dependency installer)

`pnpm setup` is the local-machine bootstrap (macOS/Ubuntu/Arch). It is
NOT shared infrastructure — it writes per-developer state to `$HOME`,
including a literal AWS config.

## AWS config is hardcoded to Pandoks_ org

- `scripts/setup/packages.sh:126-167` (`cmd_setup_aws_config`) writes
  a literal `~/.aws/config` with the `[sso-session Pandoks_]` block + 3
  hardcoded profiles (`Personal`/`tzugi-production`/`tzugi-dev`) and 3
  hardcoded `sso_account_id` values (`packages.sh:146, 152, 158`).
- **Skip-if-exists**: if `~/.aws/config` already exists and is
  non-empty (`[ -s … ]` check at `packages.sh:130`), the function
  logs a warning and returns without touching the file. To re-apply
  the committed template you must delete/move the existing file
  manually. No merging (INI merging in POSIX sh is painful).
- **If you change AWS Identity Center org, rotate the SSO start URL,
  rename a profile, change an account ID, or onboard a new
  account/profile, you MUST update `cmd_setup_aws_config` to match.**
  Existing users won't auto-pick up the change (skip-if-exists),
  but new contributors running `pnpm setup all` on a fresh machine
  will inherit whatever's committed — so the committed template
  has to stay accurate.
- The SSO start URL (`https://pandoks.awsapps.com/start` at
  `packages.sh:141`) and `sso-session Pandoks_` name are hardcoded
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

`scripts/setup/` is four files (split intentional — see
`conventions/shell.md` for the general "main.sh keeps the dispatcher
+ trivial helpers" pattern):

| File | Contains |
|------|----------|
| `main.sh` | Dispatcher + `use_sudo`, `log_step`, `install_packages` (the trivial helpers) |
| `usage.sh` | Help text |
| `env.sh` | `append_shell_rc`, `cmd_setup_ensure_package_manager`, `cmd_setup_fetch_pgp_key` |
| `packages.sh` | Every `cmd_setup_<tool>` installer + aggregators |

## Pinned versions to keep in sync with prod

- **kubectl apt repo minor** at `packages.sh:183`
  (`cmd_setup_cluster_kube_minor="v1.36"`) must match the version
  used by the prod cluster (`packages/argocd/Dockerfile:20`). When
  the prod kubectl moves, bump this in lockstep — otherwise Ubuntu
  contributors drift outside kubectl's ±1-minor support envelope
  against the cluster.
- **`.nvmrc`** is the source of truth for Node version
  (`packages.sh:21` reads it via `tr -d '[:space:]'`). No second
  copy in the installer.
- **`packageManager` in `package.json:4`** is the source of truth
  for pnpm version + integrity SHA. `corepack prepare --activate`
  (`packages.sh:32`) reads it.

## Decommissioned upstream surfaces

- **`baltocdn.com/helm/signing.asc` returns HTTP 204 / empty body**
  — the Helm apt repo was decommissioned. `packages.sh:197-210`
  uses the official `get.helm.sh` tarball + GitHub releases API
  for the latest version instead. **Don't try to revive the apt
  repo path** — the upstream URL is alive but no longer serves a
  key.
- **`hadolint` is not in any major apt/pacman repo** (Arch has it
  in AUR only). `packages.sh:182-192` (Ubuntu) and `:215-225`
  (Arch) install via GitHub releases binary download. Same for
  `actionlint` / `golangci-lint` / `govulncheck` (`go install`).
  Brew has all of them as first-party formulae.

## nvm + POSIX sh interaction

- `nvm.sh` is **bash-only** and uses constructs that trip `set -e`.
  `packages.sh:25-35` calls it from a `bash -c` subshell **without**
  `set -e` and validates by re-checking node/pnpm versions afterwards.
  **Don't add `set -e` to that bash block** — sourcing `nvm.sh`
  legitimately returns non-zero on its last internal command.

## `cmd_setup_ensure_package_manager` writes to stderr

`env.sh:42-86` wraps the apt/pacman/brew bootstrap chatter in
`{ … } 1>&2`. This is so callers can safely do
`pm=$(cmd_setup_ensure_package_manager)` to capture **only** the PM
name (`apt-get`/`pacman`/`brew`) — without this redirect, the
captured variable gets ~40 KB of `Setting up …` apt output.
**Don't unwrap the redirect.**
