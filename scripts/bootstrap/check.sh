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

check_mise_tools() {
  check_mise_tools_mise="$1" # mise binary path

  check_mise_tools_inventory=$(cd "${REPO_ROOT}" && "${check_mise_tools_mise}" ls --current 2> /dev/null)
  check_mise_tools_missing=$(
    printf '%s\n' "${check_mise_tools_inventory}" | awk '$3 == "(missing)" {print $1}'
  )

  if [ "$(uname -s)" != "Darwin" ]; then
    check_mise_tools_missing=$(printf '%s\n' "${check_mise_tools_missing}" | grep -v '^cocoapods$') || true
  fi

  if [ -z "${check_mise_tools_missing}" ]; then
    check_mise_tools_count=$(printf '%s\n' "${check_mise_tools_inventory}" | grep -c .) || true
    check_report ok "all ${check_mise_tools_count:-0} mise.toml tools installed"
    return 0
  fi

  printf '%s\n' "${check_mise_tools_missing}" | while read -r check_mise_tools_name; do
    [ -n "${check_mise_tools_name}" ] \
      && check_report fail "${check_mise_tools_name} pinned in mise.toml but not installed (run mise install)"
  done
  return 1
}


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
