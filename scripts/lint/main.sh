#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"

CRDS_CATALOG='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
readonly CRDS_CATALOG

usage() {
  printf "%bUsage:%b pnpm lint <language>\n\n" "${BOLD}" "${NORMAL}" >&2
  printf "Run linters across the monorepo.\n\n" >&2

  printf "%bLanguages:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bjs%b        ESLint over JS/TS/Svelte\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bgo%b        golangci-lint over Go modules\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bhelm%b      helm lint + kubeconform over packages/*/chart\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bdocker%b    hadolint over all Dockerfiles\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bshell%b     shellcheck over all shell scripts\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bactions%b   actionlint over GitHub Actions workflows\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %ball%b       Run every linter\n\n" "${GREEN}" "${NORMAL}" >&2

  exit "${1:-0}"
}

cmd_lint_js() {
  cd "${REPO_ROOT}" && eslint .
}

cmd_lint_go() {
  cd "${REPO_ROOT}"
  go list -m -f '{{.Dir}}/...' | xargs golangci-lint run
}

cmd_lint_docker() {
  cd "${REPO_ROOT}"
  git ls-files -z '**/Dockerfile' | xargs -0 hadolint
}

cmd_lint_shell() {
  cd "${REPO_ROOT}"
  git ls-files -z '*.sh' | xargs -0 shellcheck
}

cmd_lint_actions() {
  cd "${REPO_ROOT}" && actionlint
}

cmd_lint_helm() {
  cd "${REPO_ROOT}"
  helm lint --quiet --strict packages/*/chart
  for c in packages/*/chart; do
    helm template "$c"
  done | kubeconform \
    -strict \
    -ignore-missing-schemas \
    -schema-location default \
    -schema-location "${CRDS_CATALOG}"
}

cmd_lint_all() {
  cmd_lint_js
  cmd_lint_go
  cmd_lint_helm
  cmd_lint_docker
  cmd_lint_shell
  cmd_lint_actions
}

main() {
  [ $# -ge 1 ] || usage 0
  cmd="$1"
  shift

  case "${cmd}" in
    js) cmd_lint_js ;;
    go) cmd_lint_go ;;
    helm) cmd_lint_helm ;;
    docker) cmd_lint_docker ;;
    shell) cmd_lint_shell ;;
    actions) cmd_lint_actions ;;
    all) cmd_lint_all ;;
    help | --help | -h) usage ;;
    *)
      printf "%bError:%b Unknown language '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage 1
      ;;
  esac
}

main "$@"
