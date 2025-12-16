# shellcheck shell=sh

is_validate_ip_segment() {
  segment="$1"
  [ -z "${segment}" ] && return 1
  case "${segment}" in
    *[!0-9]*) return 1 ;;
  esac
  [ "${segment}" -ge 0 ] || return 1
  [ "${segment}" -le 255 ] || return 1
}

is_valid_ipv4() {
  # shellcheck disable=SC2046
  set -- $(printf "%s\n" "$1" | tr "." " ")
  [ $# -ne 4 ] && return 1
  for seg in "$@"; do
    is_validate_ip_segment "${seg}" || return 1
  done
}
