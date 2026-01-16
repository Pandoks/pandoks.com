#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/secrets.sh"
. "${REPO_ROOT}/scripts/lib/kubernetes.sh"
. "${SCRIPT_DIR}/usage.sh"
. "${SCRIPT_DIR}/k3d.sh"
. "${SCRIPT_DIR}/setup.sh"
. "${SCRIPT_DIR}/sst-apply.sh"

main() {
  [ $# -ge 1 ] || usage 1
  cmd="$1"
  shift

  case "${cmd}" in
    k3d) cmd_k3d "$@" ;;
    setup) cmd_setup "$@" ;;
    sst-apply) cmd_sst_apply "$@" ;;
    help | --help | -h) usage ;;
    *)
      printf "%bError:%b Unknown command '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage 1
      ;;
  esac
}

main "$@"
