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

is_valid_ip_pool_range() {
  is_valid_ip_pool_range_ip_range="$1"
  case "${is_valid_ip_pool_range_ip_range}" in
    */*)
      # CIDR form
      is_valid_ip_pool_range_base="${is_valid_ip_pool_range_ip_range%/*}"
      is_valid_ip_pool_range_mask="${is_valid_ip_pool_range_ip_range##*/}"
      is_valid_ipv4 "${is_valid_ip_pool_range_base}" || return 1
      case "${is_valid_ip_pool_range_mask}" in
        '' | *[!0-9]*) return 1 ;;
      esac
      [ "${is_valid_ip_pool_range_mask}" -ge 0 ] && [ "${is_valid_ip_pool_range_mask}" -le 32 ] || return 1
      return 0
      ;;
    *-*)
      # start-end form
      is_valid_ip_pool_range_start="${is_valid_ip_pool_range_ip_range%-*}"
      is_valid_ip_pool_range_end="${is_valid_ip_pool_range_ip_range#*-}"
      is_valid_ipv4 "${is_valid_ip_pool_range_start}" || return 1
      is_valid_ipv4 "${is_valid_ip_pool_range_end}" || return 1

      # shellcheck disable=SC2046
      set -- $(printf "%s\n" "${is_valid_ip_pool_range_start}" | tr "." " ") \
        $(printf "%s\n" "${is_valid_ip_pool_range_end}" | tr "." " ")
      [ $# -ne 8 ] && return 1
      [ "$1" -lt "$5" ] && return 0
      [ "$1" -gt "$5" ] && return 1
      [ "$2" -lt "$6" ] && return 0
      [ "$2" -gt "$6" ] && return 1
      [ "$3" -lt "$7" ] && return 0
      [ "$3" -gt "$7" ] && return 1
      [ "$4" -le "$8" ] || return 1
      return 0
      ;;
    *)
      printf "%bError:%b Invalid IP pool range: %s\n" "${RED}" "${NORMAL}" "${is_valid_ip_pool_range_ip_range}" >&2
      printf "%bAcceptable formats:%b A.B.C.D/NN (CIDR) or A.B.C.D-E.F.G.H (<start>-<end>)\n" "${BOLD}" "${NORMAL}" >&2
      return 1
      ;;
  esac
}
