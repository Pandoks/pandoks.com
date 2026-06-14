# shellcheck shell=sh

MISE_SHIMS_DIR="${HOME}/.local/share/mise/shims"
MISE_INSTALLS_DIR="${HOME}/.local/share/mise/installs"

check_report() {
  check_report_level="$1"
  shift
  case "${check_report_level}" in
    ok) printf "  %b✓%b %s\n" "${GREEN}" "${NORMAL}" "$*" >&2 ;;
    warn) printf "  %b⚠%b %s\n" "${YELLOW}" "${NORMAL}" "$*" >&2 ;;
    fail) printf "  %b✗%b %s\n" "${RED}" "${NORMAL}" "$*" >&2 ;;
  esac
}

mise_bin() {
  command -v mise 2> /dev/null && return 0
  for mise_bin_dir in $(required_path_dirs); do
    if [ -x "${mise_bin_dir}/mise" ]; then
      printf '%s' "${mise_bin_dir}/mise"
      return 0
    fi
  done
  return 1
}

check_mise_wiring() {
  if command -v mise > /dev/null 2>&1; then
    check_report ok "mise on PATH"
  else
    check_report warn "mise installed at $(dirname "$1") — not on PATH (source your rc)"
    return 1
  fi

  case ":${PATH}:" in
    *":${MISE_SHIMS_DIR}:"*)
      check_report ok "mise wired (shims on PATH)"
      return 0
      ;;
  esac
  if [ -n "${MISE_SHELL:-}" ]; then
    check_report ok "mise wired (activate, MISE_SHELL=${MISE_SHELL})"
    return 0
  fi
  check_report warn "mise not wired (rc: eval mise activate; scripts: shims dir on PATH)"
  return 1
}

print_check_report_status() {
  check_report_out="$1"  # slot file to write the ✓/✗/⚠ line to
  check_report_name="$2" # tool name, e.g. kubectl
  check_report_cmd="$3"  # version probe, e.g. 'kubectl version ... | awk ...'

  if ! command -v "${check_report_name}" > /dev/null 2>&1; then
    check_report_offpath_dir=$(
      required_path_dirs | while read -r check_report_dir; do
        [ -n "${check_report_dir}" ] || continue
        if [ -x "${check_report_dir}/${check_report_name}" ]; then
          printf '%s' "${check_report_dir}"
          break
        fi
      done
    )
    if [ -n "${check_report_offpath_dir}" ]; then # installed but not on PATH
      printf "  %b⚠%b %-14s installed at %s — not on PATH (source your rc)\n" \
        "${YELLOW}" "${NORMAL}" "${check_report_name}" "${check_report_offpath_dir}" \
        > "${check_report_out}"
    else
      printf "  %b✗%b %-14s not installed\n" "${RED}" "${NORMAL}" "${check_report_name}" \
        > "${check_report_out}"
    fi
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

  # Swift tooling is macOS-only (needs Xcode) — don't report it as missing on Linux.
  if [ "$(uname -s)" = "Darwin" ]; then
    for cmd_setup_check_spec in \
      'swiftlint|swiftlint version' \
      'swift-format|swift-format --version'; do
      print_check_report_status "${cmd_setup_check_tmp}/$(printf '%02d' "${cmd_setup_check_i}")" \
        "${cmd_setup_check_spec%%|*}" "${cmd_setup_check_spec#*|}" &
      cmd_setup_check_i=$((cmd_setup_check_i + 1))
    done
  fi
  wait

  cmd_setup_check_drifted=0
  for cmd_setup_check_slot in "${cmd_setup_check_tmp}"/*; do
    cat "${cmd_setup_check_slot}" >&2
    grep -q '✗\|⚠' "${cmd_setup_check_slot}" && cmd_setup_check_drifted=1
  done
  rm -rf "${cmd_setup_check_tmp}"
  return "${cmd_setup_check_drifted}"
}
