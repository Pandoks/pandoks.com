# shellcheck shell=sh

SETUP_BOOTSTRAP_HEADER_SHOWN=0

show_bootstrap_header() {
  [ "${SETUP_BOOTSTRAP_HEADER_SHOWN}" -eq 1 ] && return 0
  printf "\n" >&2
  log_warn "Bootstrap todos:"
  SETUP_BOOTSTRAP_HEADER_SHOWN=1
}

print_next_steps() {
  print_next_steps_step=1
  SETUP_BOOTSTRAP_HEADER_SHOWN=0

  # 1. .env.<stage> — needed if no .env.<stage> file exists yet (.env.example doesn't count — it's the template).
  if ! find "${REPO_ROOT}" -maxdepth 1 -name '.env.*' ! -name '.env.example' \
    | grep -q .; then
    show_bootstrap_header
    # shellcheck disable=SC2016
    log_warn "  ${print_next_steps_step}. cp .env.example .env.\$(whoami) and fill in CLOUDFLARE_*, HCLOUD_*, TAILSCALE_*, GITHUB_TOKEN"
    print_next_steps_step=$((print_next_steps_step + 1))
  fi

  # 2. pnpm install — needed if node_modules/ doesn't exist at repo root.
  if [ ! -d "${REPO_ROOT}/node_modules" ]; then
    show_bootstrap_header
    log_warn "  ${print_next_steps_step}. pnpm install"
    print_next_steps_step=$((print_next_steps_step + 1))
  fi

  # 3. pnpm sso — needed if no unexpired SSO cache token exists.
  if ! ls "${HOME}"/.aws/sso/cache/*.json > /dev/null 2>&1; then
    show_bootstrap_header
    log_warn "  ${print_next_steps_step}. pnpm sso"
  fi

  # warnings about session/OS state the user must investigate (not commands that we suggest)
  print_next_steps_os=$(get_os)
  # Docker group (Linux only): warn if user isn't in 'docker' group yet.
  if [ "${print_next_steps_os}" != "macos" ] \
    && command -v docker > /dev/null 2>&1 \
    && ! id -nG 2> /dev/null | grep -qw docker; then
    printf "\n" >&2
    log_warn "Group changes pending:"
    log_warn "  - 'docker' group: log out + back in (required to run docker without sudo)"
  fi

  # Docker Desktop (macOS only): warn if daemon isn't reachable.
  if [ "${print_next_steps_os}" = "macos" ] \
    && command -v docker > /dev/null 2>&1 \
    && ! docker info > /dev/null 2>&1; then
    printf "\n" >&2
    log_warn "Manual app launches pending:"
    log_warn "  - Docker Desktop: open it once so the engine daemon starts"
  fi
}
