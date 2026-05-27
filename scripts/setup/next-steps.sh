# shellcheck shell=sh

SETUP_BOOTSTRAP_HEADER_SHOWN=0

cmd_setup_show_bootstrap_header() {
  [ "${SETUP_BOOTSTRAP_HEADER_SHOWN}" -eq 1 ] && return 0
  printf "\n" >&2
  log_warn "Bootstrap todos:"
  SETUP_BOOTSTRAP_HEADER_SHOWN=1
}
