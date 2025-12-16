# shellcheck shell=sh

is_valid_ip_segment() {
  is_valid_ip_segment_segment="$1"
  [ -z "${is_valid_ip_segment_segment}" ] && return 1
  case "${is_valid_ip_segment_segment}" in
    *[!0-9]*) return 1 ;;
  esac
  [ "${is_valid_ip_segment_segment}" -ge 0 ] || return 1
  [ "${is_valid_ip_segment_segment}" -le 255 ] || return 1
}

is_valid_ipv4() {
  # shellcheck disable=SC2046
  set -- $(printf "%s\n" "$1" | tr "." " ")
  [ $# -ne 4 ] && return 1
  for is_valid_ipv4_segment in "$@"; do
    is_valid_ip_segment "${is_valid_ipv4_segment}" || return 1
  done
}
