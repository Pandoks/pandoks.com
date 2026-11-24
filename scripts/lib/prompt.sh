# shellcheck shell=sh

prompt_secret() {
  node "${REPO_ROOT}/scripts/lib/prompt.ts" "$1"
}
