# shellcheck shell=sh

check_major_match() {
  check_major_match_want="$1"    # wanted major, e.g. 24
  check_major_match_version="$2" # raw installed version, e.g. v24.15.0
  [ -z "${check_major_match_want}" ] && return 0
  check_major_match_have=$(printf '%s' "${check_major_match_version}" | sed 's/^v//' | cut -d. -f1)
  [ "${check_major_match_have}" = "${check_major_match_want}" ] \
    || printf 'want major %s' "${check_major_match_want}"
}

version_drift() {
  version_drift_name="$1"    # tool name, e.g. kubectl
  version_drift_version="$2" # raw installed version, e.g. v1.36.1
  case "${version_drift_name}" in
    node)
      check_major_match "$(read_nvmrc)" "${version_drift_version}"
      ;;
    pnpm)
      check_major_match \
        "$(pnpm_spec | sed 's/^pnpm@//' | cut -d. -f1)" \
        "${version_drift_version}"
      ;;
    helm)
      check_major_match \
        "$(printf '%s' "${HELM_VERSION}" | sed 's/^v//' | cut -d. -f1)" \
        "${version_drift_version}"
      ;;
    aws)
      case "${version_drift_version}" in
        aws-cli/2.*) ;;
        *) printf 'want aws-cli/2.x' ;;
      esac
      ;;
    kubectl)
      # kubectl supports +/-1 minor skew against the cluster pin
      version_drift_want=$(kubectl_pinned_minor)
      [ -z "${version_drift_want}" ] && return 0
      version_drift_want_minor=${version_drift_want#*.}
      version_drift_have=$(printf '%s' "${version_drift_version}" \
        | sed 's/^v//' | cut -d. -f1-2)
      version_drift_have_minor=${version_drift_have#*.}
      case "${version_drift_have_minor}" in
        '' | *[!0-9]*) return 0 ;;
      esac
      version_drift_skew=$((version_drift_have_minor - version_drift_want_minor))
      if [ "${version_drift_skew}" -lt -1 ] || [ "${version_drift_skew}" -gt 1 ]; then
        printf 'want %s +/-1 minor' "${version_drift_want}"
      fi
      ;;
  esac
}

print_check_report_status() {
  check_report_out="$1"  # slot file to write the ✓/✗ line to
  check_report_name="$2" # tool name, e.g. kubectl
  check_report_cmd="$3"  # version probe, e.g. 'kubectl version ... | awk ...'

  # missing → red ✗ "not installed"
  if ! command -v "${check_report_name}" > /dev/null 2>&1; then
    printf "  %b✗%b %-14s not installed\n" "${RED}" "${NORMAL}" "${check_report_name}" \
      > "${check_report_out}"
    return
  fi

  check_report_version=$(eval "${check_report_cmd}" 2>&1 | head -n1)
  check_report_drift=$(version_drift "${check_report_name}" "${check_report_version}")

  # drifted → red ✗ "<version> (want ...)"
  if [ -n "${check_report_drift}" ]; then
    printf "  %b✗%b %-14s %s (%s)\n" "${RED}" "${NORMAL}" "${check_report_name}" \
      "${check_report_version}" "${check_report_drift}" > "${check_report_out}"
    return
  fi

  # in spec → green ✓ "<version>"
  printf "  %b✓%b %-14s %s\n" "${GREEN}" "${NORMAL}" "${check_report_name}" \
    "${check_report_version}" > "${check_report_out}"
}

cmd_setup_check() {
  log_step "Detected versions"

  cmd_setup_check_tmp=$(mktemp -d)
  cmd_setup_check_i=0
  # shellcheck disable=SC2016
  for cmd_setup_check_spec in \
    'node|node --version' \
    'pnpm|pnpm --version' \
    'uv|uv --version' \
    'go|go version' \
    'aws|aws --version' \
    'docker|docker --version' \
    'kubectl|kubectl version --client --output=yaml | awk "/gitVersion/ {print \$2; exit}"' \
    'k3d|k3d version | awk "/k3d version/ {print \$3; exit}"' \
    'helm|helm version --short' \
    'kubeconform|kubeconform -v' \
    'jq|jq --version' \
    'openssl|openssl version' \
    'htpasswd|htpasswd -v 2>&1 | head -n1 || echo present' \
    'shellcheck|shellcheck --version | awk "/^version:/ {print \$2}"' \
    'shfmt|shfmt --version' \
    'hadolint|hadolint --version' \
    'actionlint|actionlint -version | head -n1' \
    'golangci-lint|golangci-lint --version | head -n1' \
    'govulncheck|govulncheck -version | head -n1'; do
    print_check_report_status "${cmd_setup_check_tmp}/$(printf '%02d' "${cmd_setup_check_i}")" \
      "${cmd_setup_check_spec%%|*}" "${cmd_setup_check_spec#*|}" &
    cmd_setup_check_i=$((cmd_setup_check_i + 1))
  done
  wait

  cmd_setup_check_drifted=0
  for cmd_setup_check_slot in "${cmd_setup_check_tmp}"/*; do
    cat "${cmd_setup_check_slot}" >&2
    grep -q '✗' "${cmd_setup_check_slot}" && cmd_setup_check_drifted=1
  done
  rm -rf "${cmd_setup_check_tmp}"
  return "${cmd_setup_check_drifted}"
}
