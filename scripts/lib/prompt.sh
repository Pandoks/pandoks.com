# shellcheck shell=sh

# NOTE: hides typed input, shows live masked feedback on a TTY, trims whitespace, and prints on stdout
prompt_secret() {
  node "${REPO_ROOT}/scripts/lib/prompt-secret.ts" "$1"
}
