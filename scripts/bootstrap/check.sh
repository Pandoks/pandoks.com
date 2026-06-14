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

check_mise_managed_tools() {
  [ -d "${MISE_SHIMS_DIR}" ] || return 0
  check_mise_managed_tools_bad=0

  for check_mise_managed_tools_shim in "${MISE_SHIMS_DIR}"/*; do
    [ -e "${check_mise_managed_tools_shim}" ] || continue
    check_mise_managed_tools_name="${check_mise_managed_tools_shim##*/}"
    check_mise_managed_tools_at=$(command -v "${check_mise_managed_tools_name}" 2> /dev/null) || continue

    case "${check_mise_managed_tools_at}" in
      "${check_mise_managed_tools_shim}" | "${MISE_INSTALLS_DIR}/"*) continue ;;
    esac

    if (cd "${REPO_ROOT}" && "$1" which "${check_mise_managed_tools_name}" > /dev/null 2>&1); then
      check_report fail "shadowed: ${check_mise_managed_tools_name} resolves to ${check_mise_managed_tools_at}"
      check_mise_managed_tools_bad=1
    fi
  done

  [ "${check_mise_managed_tools_bad}" -eq 0 ] && check_report ok "no mise tool shadowed on PATH"
  return "${check_mise_managed_tools_bad}"
}

check_system_tools() {
  check_system_tools_list="docker openssl htpasswd"
  [ "$(uname -s)" = "Darwin" ] && check_system_tools_list="${check_system_tools_list} swift-format"

  check_system_tools_failed=0
  for check_system_tools_name in ${check_system_tools_list}; do
    if command -v "${check_system_tools_name}" > /dev/null 2>&1; then
      check_report ok "${check_system_tools_name} present"
    else
      check_report fail "${check_system_tools_name} not installed"
      check_system_tools_failed=1
    fi
  done
  return "${check_system_tools_failed}"
}
