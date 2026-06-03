#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${REPO_ROOT}/scripts/lib/sst.sh"
. "${REPO_ROOT}/scripts/lib/template.sh"
. "${REPO_ROOT}/scripts/lib/kubernetes.sh"
. "${SCRIPT_DIR}/usage.sh"
. "${SCRIPT_DIR}/k3d.sh"
. "${SCRIPT_DIR}/deploy.sh"

main() {
  [ $# -ge 1 ] || usage 1
  cmd="$1"
  shift

  case "${cmd}" in
    k3d) cmd_k3d "$@" ;;
    deploy) cmd_deploy "$@" ;;
    help | --help | -h) usage ;;
    *)
      log_error "Unknown command '${cmd}'"
      usage 1
      ;;
  esac
}

main "$@"
