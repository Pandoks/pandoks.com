#!/bin/bash
# shellcheck shell=bash  # bash required: sources nvm.sh (bash-only) + uses pipefail
set -uo pipefail

# Web-only: local machines bootstrap via `pnpm setup` instead.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 1

node_version="$(tr -d '[:space:]' < .nvmrc)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# nvm.sh is bash-only and its last internal command can exit non-zero, so it
# must not run under `set -e` (see .claude/rules/gotchas/setup.md).
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$node_version"
nvm use "$node_version"

set -e

node_bin_dir="$(dirname "$(nvm which "$node_version")")"

# The hook runs in its own subprocess, so a bare `nvm use`/`export` would not
# reach the agent's session. $CLAUDE_ENV_FILE is the supported bridge: lines
# written here are loaded into the session's environment.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$node_bin_dir:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

pnpm install
