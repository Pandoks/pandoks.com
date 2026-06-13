#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${REPO_ROOT}/scripts/lib/os.sh"
. "${SCRIPT_DIR}/usage.sh"
. "${SCRIPT_DIR}/env.sh"
. "${SCRIPT_DIR}/install.sh"
. "${SCRIPT_DIR}/check.sh"
. "${SCRIPT_DIR}/next-steps.sh"

use_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

log_step() {
  printf "%b==>%b %s\n" "${BOLD}" "${NORMAL}" "$*" >&2
}

install_packages() {
  install_packages_package_manager="$1" # brew | apt-get | pacman
  shift

  case "${install_packages_package_manager}" in
    brew) brew install "$@" ;;
    apt-get) use_sudo apt-get install -y "$@" ;;
    pacman) use_sudo pacman -S --noconfirm --needed "$@" ;;
    *) die "Unsupported package manager: ${install_packages_package_manager}" ;;
  esac
}

main() {
  [ $# -ge 1 ] || usage 0
  cmd="$1"
  shift

  case "${cmd}" in
    all) cmd_setup_all "$@" ;;
    check) cmd_setup_check "$@" ;;
    help | --help | -h) usage ;;
    *)
      log_error "Unknown command '${cmd}'"
      usage 1
      ;;
  esac
}

main "$@"
