# shellcheck shell=sh

append_shell_rc() {
  append_shell_rc_line="$1" # Line to add

  if [ -z "${SHELL:-}" ]; then
    log_warn "SHELL not set — add this to your rc file manually: ${append_shell_rc_line}"
    return 0
  fi

  append_shell_rc_shell=$(get_shell 2> /dev/null) || {
    log_warn "Could not detect shell — add manually: ${append_shell_rc_line}"
    return 0
  }
  is_supported_shell "${append_shell_rc_shell}" 2> /dev/null || {
    log_warn "Unsupported shell — add manually: ${append_shell_rc_line}"
    return 0
  }
  append_shell_rc_file=$(get_shell_rc_file "${append_shell_rc_shell}" 2> /dev/null) || {
    log_warn "Could not resolve rc file — add manually: ${append_shell_rc_line}"
    return 0
  }

  [ -f "${append_shell_rc_file}" ] || touch "${append_shell_rc_file}"
  if ! grep -Fqx "${append_shell_rc_line}" "${append_shell_rc_file}"; then
    printf '%s\n' "${append_shell_rc_line}" >> "${append_shell_rc_file}"
  fi
}
