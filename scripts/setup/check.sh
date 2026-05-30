# shellcheck shell=sh

check_major_match() {
  check_major_match_want="$1"    # wanted major, e.g. 24
  check_major_match_version="$2" # raw installed version, e.g. v24.15.0
  [ -z "${check_major_match_want}" ] && return 0
  check_major_match_have=$(printf '%s' "${check_major_match_version}" | sed 's/^v//' | cut -d. -f1)
  [ "${check_major_match_have}" = "${check_major_match_want}" ] \
    || printf 'want major %s' "${check_major_match_want}"
}

check_pin_drift() {
  check_pin_drift_name="$1"      # tool name, e.g. kubectl
  check_pin_drift_version="$2"   # raw installed version, e.g. v1.36.1
  case "${check_pin_drift_name}" in
    node)
      check_major_match "$(read_nvmrc)" "${check_pin_drift_version}"
      ;;
    pnpm)
      check_major_match \
        "$(pnpm_spec | sed 's/^pnpm@//' | cut -d. -f1)" \
        "${check_pin_drift_version}"
      ;;
    helm)
      check_major_match \
        "$(printf '%s' "${HELM_VERSION}" | sed 's/^v//' | cut -d. -f1)" \
        "${check_pin_drift_version}"
      ;;
    aws)
      case "${check_pin_drift_version}" in
        aws-cli/2.*) ;;
        *) printf 'want aws-cli/2.x' ;;
      esac
      ;;
    kubectl)
      # kubectl supports +/-1 minor skew against the cluster pin
      check_pin_drift_want=$(kubectl_pinned_minor)
      [ -z "${check_pin_drift_want}" ] && return 0
      check_pin_drift_want_minor=${check_pin_drift_want#*.}
      check_pin_drift_have=$(printf '%s' "${check_pin_drift_version}" \
        | sed 's/^v//' | cut -d. -f1-2)
      check_pin_drift_have_minor=${check_pin_drift_have#*.}
      case "${check_pin_drift_have_minor}" in
        '' | *[!0-9]*) return 0 ;;
      esac
      check_pin_drift_skew=$((check_pin_drift_have_minor - check_pin_drift_want_minor))
      if [ "${check_pin_drift_skew}" -lt -1 ] || [ "${check_pin_drift_skew}" -gt 1 ]; then
        printf 'want %s +/-1 minor' "${check_pin_drift_want}"
      fi
      ;;
  esac
}
