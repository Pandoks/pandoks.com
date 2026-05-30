# shellcheck shell=sh

check_major_match() {
  check_major_match_want="$1"    # wanted major, e.g. 24
  check_major_match_version="$2" # raw installed version, e.g. v24.15.0
  [ -z "${check_major_match_want}" ] && return 0
  check_major_match_have=$(printf '%s' "${check_major_match_version}" | sed 's/^v//' | cut -d. -f1)
  [ "${check_major_match_have}" = "${check_major_match_want}" ] \
    || printf 'want major %s' "${check_major_match_want}"
}
