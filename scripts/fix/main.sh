#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"

usage() {
  printf "%bUsage:%b pnpm fix <language>\n\n" "${BOLD}" "${NORMAL}" >&2
  printf "Apply auto-fixes for lint findings.\n\n" >&2

  printf "%bLanguages:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bjs%b   ESLint --fix\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bgo%b   golangci-lint run --fix\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %ball%b  Apply every fixer\n\n" "${GREEN}" "${NORMAL}" >&2

  exit "${1:-0}"
}

cmd_fix_js() {
  cd "${REPO_ROOT}" && eslint . --fix
}

cmd_fix_go() {
  cd "${REPO_ROOT}"
  go list -m -f '{{.Dir}}/...' | xargs golangci-lint run --fix
}

cmd_fix_all() {
  cmd_fix_js
  cmd_fix_go
}

main() {
  [ $# -ge 1 ] || usage 0
  cmd="$1"
  shift

  case "${cmd}" in
    js) cmd_fix_js ;;
    go) cmd_fix_go ;;
    all) cmd_fix_all ;;
    help | --help | -h) usage ;;
    *)
      printf "%bError:%b Unknown language '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage 1
      ;;
  esac
}

main "$@"
