#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"

usage() {
  printf "%bUsage:%b pnpm format <command>\n\n" "${BOLD}" "${NORMAL}" >&2
  printf "Format files across the monorepo.\n\n" >&2

  printf "%bWrite mode:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bjs%b           Prettier over JS/TS/Svelte/MD/YAML/JSON\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bgo%b           golangci-lint fmt over Go modules\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bshell%b        shfmt over shell scripts\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %ball%b          Format all\n\n" "${GREEN}" "${NORMAL}" >&2

  printf "%bCheck mode (no writes):%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bcheck js%b     Prettier --check\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bcheck go%b     golangci-lint fmt --diff\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bcheck shell%b  shfmt -d\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bcheck all%b    Check all\n\n" "${GREEN}" "${NORMAL}" >&2

  exit "${1:-0}"
}

cmd_format_js() {
  cd "${REPO_ROOT}" && prettier --write .
}

cmd_format_go() {
  cd "${REPO_ROOT}" && golangci-lint fmt
}

cmd_format_shell() {
  cd "${REPO_ROOT}"
  git ls-files -z '*.sh' | xargs -0 shfmt -w
}

cmd_format_all() {
  cmd_format_js
  cmd_format_go
  cmd_format_shell
}

cmd_format_check_js() {
  cd "${REPO_ROOT}" && prettier --check .
}

cmd_format_check_go() {
  cd "${REPO_ROOT}" && golangci-lint fmt --diff
}

cmd_format_check_shell() {
  cd "${REPO_ROOT}"
  git ls-files -z '*.sh' | xargs -0 shfmt -d
}

cmd_format_check_all() {
  cmd_format_check_js
  cmd_format_check_go
  cmd_format_check_shell
}

cmd_format_check() {
  [ $# -ge 1 ] || usage 0
  cmd="$1"
  shift

  case "${cmd}" in
    js) cmd_format_check_js ;;
    go) cmd_format_check_go ;;
    shell) cmd_format_check_shell ;;
    all) cmd_format_check_all ;;
    help | --help | -h) usage ;;
    *)
      printf "%bError:%b Unknown check language '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage 1
      ;;
  esac
}

main() {
  [ $# -ge 1 ] || usage 0
  cmd="$1"
  shift

  case "${cmd}" in
    js) cmd_format_js ;;
    go) cmd_format_go ;;
    shell) cmd_format_shell ;;
    all) cmd_format_all ;;
    check) cmd_format_check "$@" ;;
    help | --help | -h) usage ;;
    *)
      printf "%bError:%b Unknown command '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage 1
      ;;
  esac
}

main "$@"
