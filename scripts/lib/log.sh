# shellcheck shell=sh

_print_log() {
  _print_log_prefix="$1"
  shift
  case "${1:-}" in
    --quiet | --quiet=true) return 0 ;;
    --quiet=false) shift ;;
  esac
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  printf "%b%s\n" "${_print_log_prefix}" "$*"
}

log_error() {
  _print_log "${RED}Error:${NORMAL} " "$@" >&2
}

log_ok() {
  _print_log "${GREEN}✓${NORMAL} " "$@"
}

log_warn() {
  _print_log "${YELLOW}!${NORMAL} " "$@" >&2
}

log_info() {
  _print_log "" "$@" >&2
}

die() {
  log_error -- "$*"
  exit 1
}
