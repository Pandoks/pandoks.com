# shellcheck shell=sh

log_error() {
  printf "%bError:%b %s\n" "${RED}" "${NORMAL}" "$*" >&2
}

log_ok() {
  printf "%b✓%b %s\n" "${GREEN}" "${NORMAL}" "$*"
}

log_warn() {
  printf "%b!%b %s\n" "${YELLOW}" "${NORMAL}" "$*" >&2
}

die() {
  log_error "$*"
  exit 1
}
