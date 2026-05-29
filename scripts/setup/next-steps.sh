# shellcheck shell=sh

SETUP_BOOTSTRAP_HEADER_SHOWN=0

show_bootstrap_header() {
  [ "${SETUP_BOOTSTRAP_HEADER_SHOWN}" -eq 1 ] && return 0
  printf "\n" >&2
  log_warn "Bootstrap todos:"
  SETUP_BOOTSTRAP_HEADER_SHOWN=1
}

cmd_setup_print_next_steps() {
  # --- Section 1: activation for tools installed this run ---
  if [ "${SETUP_INSTALLED_NODE}" -eq 1 ] \
    || [ "${SETUP_INSTALLED_UV}" -eq 1 ] \
    || [ "${SETUP_INSTALLED_GO}" -eq 1 ]; then
    printf "\n" >&2
    log_warn "Activate in your current shell (new terminals auto-pick this up):"
    cmd_setup_print_next_steps_rc=""
    if [ -n "${SHELL:-}" ]; then
      cmd_setup_print_next_steps_shell=$(get_shell 2> /dev/null) || cmd_setup_print_next_steps_shell=""
      if [ -n "${cmd_setup_print_next_steps_shell}" ] && is_supported_shell "${cmd_setup_print_next_steps_shell}" 2> /dev/null; then
        cmd_setup_print_next_steps_rc=$(get_shell_rc_file "${cmd_setup_print_next_steps_shell}" 2> /dev/null) || cmd_setup_print_next_steps_rc=""
      fi
    fi
    if [ -n "${cmd_setup_print_next_steps_rc}" ]; then
      log_warn "  source ${cmd_setup_print_next_steps_rc}    # interactive shells only"
      printf "\n" >&2
    fi
    log_warn "  # for non-interactive shells (CI / wrappers / Claude Code Cloud):"
    if [ "${SETUP_INSTALLED_NODE}" -eq 1 ]; then
      # shellcheck disable=SC2016
      log_warn '  export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use   # Node from .nvmrc'
    fi
    if [ "${SETUP_INSTALLED_UV}" -eq 1 ]; then
      # shellcheck disable=SC2016
      log_warn '  export PATH="$HOME/.local/bin:$PATH"                            # uv'
    fi
    if [ "${SETUP_INSTALLED_GO}" -eq 1 ]; then
      # shellcheck disable=SC2016
      log_warn '  export PATH="$(go env GOPATH)/bin:$PATH"                        # govulncheck, kubeconform, actionlint, golangci-lint'
    fi
  fi

  # --- Section 2: persistent bootstrap todos (filesystem-detected) ---
  cmd_setup_print_next_steps_step=1
  SETUP_BOOTSTRAP_HEADER_SHOWN=0

  # 1. .env.<stage> — needed if no .env.<stage> file exists yet (.env.example doesn't count — it's the template).
  if ! find "${REPO_ROOT}" -maxdepth 1 -name '.env.*' ! -name '.env.example' \
    | grep -q .; then
    cmd_setup_show_bootstrap_header
    # shellcheck disable=SC2016
    log_warn "  ${cmd_setup_print_next_steps_step}. cp .env.example .env.\$(whoami) and fill in CLOUDFLARE_*, HCLOUD_*, TAILSCALE_*, GITHUB_TOKEN"
    cmd_setup_print_next_steps_step=$((cmd_setup_print_next_steps_step + 1))
  fi

  # 2. pnpm install — needed if node_modules/ doesn't exist at repo root.
  if [ ! -d "${REPO_ROOT}/node_modules" ]; then
    cmd_setup_show_bootstrap_header
    log_warn "  ${cmd_setup_print_next_steps_step}. pnpm install"
    cmd_setup_print_next_steps_step=$((cmd_setup_print_next_steps_step + 1))
  fi

  # 3. pnpm sso — needed if no unexpired SSO cache token exists.
  if ! ls "${HOME}"/.aws/sso/cache/*.json > /dev/null 2>&1; then
    cmd_setup_show_bootstrap_header
    log_warn "  ${cmd_setup_print_next_steps_step}. pnpm sso"
  fi

  # --- Section 3: post-install OS reminders ---
  cmd_setup_print_next_steps_os=$(get_os)

  # Docker group (Linux only): warn if user isn't in 'docker' group yet.
  if [ "${cmd_setup_print_next_steps_os}" != "macos" ] \
    && command -v docker > /dev/null 2>&1 \
    && ! id -nG 2> /dev/null | grep -qw docker; then
    printf "\n" >&2
    log_warn "Group changes pending:"
    log_warn "  - 'docker' group: log out + back in (required to run docker without sudo)"
  fi

  # Docker Desktop (macOS only): warn if daemon isn't reachable.
  if [ "${cmd_setup_print_next_steps_os}" = "macos" ] \
    && command -v docker > /dev/null 2>&1 \
    && ! docker info > /dev/null 2>&1; then
    printf "\n" >&2
    log_warn "Manual app launches pending:"
    log_warn "  - Docker Desktop: open it once so the engine daemon starts"
  fi
}
