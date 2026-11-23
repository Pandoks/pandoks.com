# shellcheck shell=sh

print_banner() {
  printf "\n%b┌%b  %bpandoks.com%b %b· %s%b\n" "${DIM}" "${NORMAL}" "${BOLD}" "${NORMAL}" "${DIM}" "$1" "${NORMAL}"
  printf "%b│%b  %b%s%b\n" "${DIM}" "${NORMAL}" "${DIM}" "$2" "${NORMAL}"
}

print_section() {
  printf "%b│%b\n" "${DIM}" "${NORMAL}"
  printf "%b◇%b  %b%s%b\n" "${CYAN}" "${NORMAL}" "${BOLD}" "$1" "${NORMAL}"
}

print_ok() {
  printf "%b│%b  %b✓%b %s\n" "${DIM}" "${NORMAL}" "${GREEN}" "${NORMAL}" "$*"
}

print_added() {
  printf "%b│%b  %b+%b %s\n" "${DIM}" "${NORMAL}" "${CYAN}" "${NORMAL}" "$*"
}

print_footer() {
  printf "%b│%b\n" "${DIM}" "${NORMAL}"
  printf "%b└%b  %b✓%b %b%s%b\n\n" "${DIM}" "${NORMAL}" "${GREEN}" "${NORMAL}" "${BOLD}" "$1" "${NORMAL}"
}

run_device_login() {
  run_device_login_label=$1
  shift

  run_device_login_status_file=$(mktemp)
  run_device_login_log_file=$(mktemp)
  run_device_login_expect_code=0
  run_device_login_url=''
  run_device_login_code=''
  run_device_login_printed=0

  (
    run_device_login_rc=0
    "$@" < /dev/null 2>&1 || run_device_login_rc=$?
    printf '%s\n' "${run_device_login_rc}" > "${run_device_login_status_file}"
  ) | while IFS= read -r run_device_login_line; do
    printf '%s\n' "${run_device_login_line}" >> "${run_device_login_log_file}"
    run_device_login_trimmed=$(printf '%s' "${run_device_login_line}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ "${run_device_login_expect_code}" -eq 1 ] && [ -n "${run_device_login_trimmed}" ]; then
      run_device_login_code="${run_device_login_trimmed}"
      run_device_login_expect_code=0
    else
      case "${run_device_login_trimmed}" in
        https://*)
          run_device_login_url="${run_device_login_trimmed}"
          ;;
        *"enter the code:"*)
          run_device_login_expect_code=1
          ;;
        *"One-time code ("*)
          run_device_login_code=$(printf '%s' "${run_device_login_trimmed}" | sed -n 's/.*One-time code (\([^)]*\)).*/\1/p')
          ;;
        *"one-time code:"*)
          run_device_login_code=$(printf '%s' "${run_device_login_trimmed}" | sed -n 's/.*one-time code:[[:space:]]*//p')
          ;;
        *"Open this URL"*https://*)
          run_device_login_url=$(printf '%s' "${run_device_login_trimmed}" | sed -n 's|.*\(https://[^[:space:]]*\).*|\1|p')
          ;;
      esac
    fi

    if [ "${run_device_login_printed}" -eq 0 ] && [ -n "${run_device_login_url}" ] && [ -n "${run_device_login_code}" ]; then
      printf "%b│%b\n" "${DIM}" "${NORMAL}" >&2
      printf "%b│%b  %bAuthorize %s%b\n" "${DIM}" "${NORMAL}" "${BOLD}" "${run_device_login_label}" "${NORMAL}" >&2
      printf "%b│%b  %b%s%b\n" "${DIM}" "${NORMAL}" "${CYAN}" "${run_device_login_url}" "${NORMAL}" >&2
      printf "%b│%b  Code: %b%s%b\n" "${DIM}" "${NORMAL}" "${BOLD}${YELLOW}" "${run_device_login_code}" "${NORMAL}" >&2
      printf "%b│%b\n" "${DIM}" "${NORMAL}" >&2
      run_device_login_printed=1
    fi
  done

  run_device_login_status=$(cat "${run_device_login_status_file}")
  if [ "${run_device_login_status}" -ne 0 ]; then
    cat "${run_device_login_log_file}" >&2
    rm -f "${run_device_login_status_file}" "${run_device_login_log_file}"
    return "${run_device_login_status}"
  fi
  rm -f "${run_device_login_status_file}" "${run_device_login_log_file}"
}

cleanup_device_login() {
  for cleanup_device_login_file in "${run_device_login_status_file:-}" "${run_device_login_log_file:-}"; do
    if [ -n "${cleanup_device_login_file}" ]; then
      rm -f "${cleanup_device_login_file}"
    fi
  done
}
