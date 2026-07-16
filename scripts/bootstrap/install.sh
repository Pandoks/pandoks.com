# shellcheck shell=sh

install_mise() {
  if ! command -v mise > /dev/null 2>&1; then
    install_mise_package_manager=$(ensure_package_manager)
    case "${install_mise_package_manager}" in
      brew) install_packages brew mise ;;
      apt)
        log_step "Installing mise from its apt repository"
        install_packages apt extrepo
        use_sudo extrepo enable mise
        use_sudo apt-get update -y
        install_packages apt mise
        ;;
      pacman) install_packages pacman mise ;;
    esac
    command -v mise > /dev/null 2>&1 || die "mise installation failed"
  fi
  PATH="${HOME}/.local/share/mise/shims:${PATH}"
  export PATH # exposes mise for the rest of the script after initial install
  log_ok "mise $(mise --no-config version)"
}

bootstrap_with_mise() {
  log_step "Bootstrapping system packages, shell activation, and toolchain with mise"
  bootstrap_with_mise_package_managers=$(mise_package_managers_for "$(ensure_package_manager)") \
    || die "No supported mise system package manager found"
  (
    export MISE_SYSTEM_PACKAGES_MANAGERS="${bootstrap_with_mise_package_managers}"
    mise -C "${REPO_ROOT}" trust > /dev/null 2>&1
    mise -C "${REPO_ROOT}" bootstrap --yes --update
    mise -C "${REPO_ROOT}" bootstrap packages upgrade --yes
  ) || die "mise bootstrap failed"
  log_ok "mise bootstrap complete"
}

install_global_tools() {
  log_step "Installing global tools for the current user"
  (
    entries=$(mise config get --file "${REPO_ROOT}/mise.toml" _.global_tools 2> /dev/null)
    [ -n "${entries}" ] || exit 0

    while IFS= read -r entry; do
      tool=${entry%% = *}
      version=${entry#* = \"}
      version=${version%\"}
      mise --no-config use --global --pin --yes "${tool}@${version}" || exit 1
    done << EOF
${entries}
EOF
  ) || die "Global mise tool installation failed"
  log_ok "global tools available for $(id -un)"
}

install_aws_config() {
  install_aws_config_dir="${HOME}/.aws"
  install_aws_config_file="${install_aws_config_dir}/config"

  if [ -s "${install_aws_config_file}" ]; then
    printf '  %b[aws]%b  AWS config already present (~/.aws/config)\n' "${GREEN}" "${NORMAL}" >&2
    return 0
  fi

  mkdir -p "${install_aws_config_dir}"
  chmod 700 "${install_aws_config_dir}"

  cat > "${install_aws_config_file}" << 'EOF'
[sso-session Pandoks_]
sso_start_url = https://pandoks.awsapps.com/start
sso_region = us-west-1

[profile Personal]
sso_session = Pandoks_
sso_account_id = 343487555569
sso_role_name = AdministratorAccess
region = us-west-1

[profile tzugi-production]
sso_session = Pandoks_
sso_account_id = 568555767113
sso_role_name = AdministratorAccess
region = us-west-1

[profile tzugi-dev]
sso_session = Pandoks_
sso_account_id = 489335433499
sso_role_name = AdministratorAccess
region = us-west-1
EOF
  chmod 600 "${install_aws_config_file}"
  printf '  %b[aws]%b  Wrote ~/.aws/config (SSO session + 3 profiles)\n' "${GREEN}" "${NORMAL}" >&2
}

configure_docker_package_source() {
  configure_docker_package_manager=$(ensure_package_manager)
  case "${configure_docker_package_manager}" in
    apt)
      if [ -f /etc/apt/sources.list.d/docker.list ] || [ -f /etc/apt/sources.list.d/docker.sources ]; then
        return 0
      fi
      log_step "Configuring Docker's apt repository"
      use_sudo install -m 0755 -d /etc/apt/keyrings
      # Docker serves separate ubuntu/ and debian/ apt repos; ID picks the right one.
      configure_docker_distro=$(. /etc/os-release && [ "${ID:-}" = debian ] && echo debian || echo ubuntu) # NOTE: os-release defines ID
      fetch_pgp_key \
        "https://download.docker.com/linux/${configure_docker_distro}/gpg" \
        /etc/apt/keyrings/docker.gpg \
        "docker"
      use_sudo chmod a+r /etc/apt/keyrings/docker.gpg
      configure_docker_arch=$(dpkg --print-architecture)
      configure_docker_codename=$(. /etc/os-release && echo "${VERSION_CODENAME}") # NOTE: os-release defines VERSION_CODENAME
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
        "${configure_docker_arch}" "${configure_docker_distro}" "${configure_docker_codename}" \
        | use_sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
      ;;
  esac
}

configure_docker_runtime() {
  command -v docker > /dev/null 2>&1 || die "Docker installation failed"
  configure_docker_runtime_package_manager=$(ensure_package_manager)
  case "${configure_docker_runtime_package_manager}" in
    brew) log_warn "Open Docker Desktop once so the engine daemon starts" ;;
    apt | pacman)
      use_sudo systemctl enable --now docker.service
      if ! id -nG 2> /dev/null | grep -qw docker; then
        use_sudo usermod -aG docker "$(id -un)"
        log_warn "Log out + back in for the 'docker' group membership to take effect"
      fi
      ;;
  esac
  log_ok "Docker installed: $(docker --version)"
}

reload_or_hint() {
  reload_or_hint_reload="$1" # 1 if --reload was passed

  if [ "${reload_or_hint_reload}" = 1 ] && [ -t 0 ] && [ -t 1 ] && [ -n "${SHELL:-}" ]; then
    printf "\n" >&2
    log_step "Reloading your shell so mise is live (--reload)"
    exec "${SHELL}" -l
  fi

  [ -z "${MISE_SHELL:-}" ] || return 0
  printf "\n" >&2
  log_warn "mise is wired into your shell rc. New terminals get it automatically."
  log_warn "To use it in THIS shell now, run:"
  log_warn "    eval \"\$(mise activate $(get_shell 2> /dev/null || echo zsh))\""
  log_warn "  (or restart your shell, or re-run with: pnpm bootstrap all --reload)"
}

cmd_bootstrap_all() {
  populate_proper_pathing
  ensure_package_manager > /dev/null

  install_mise
  configure_docker_package_source
  bootstrap_with_mise
  install_global_tools
  configure_docker_runtime
  install_aws_config

  printf "\n" >&2
  log_ok "Bootstrap complete. Run 'pnpm bootstrap check' to inventory versions / detect drift."
  print_next_steps

  if [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    while read -r cmd_bootstrap_all_dir; do
      # shellcheck disable=SC2016
      [ -n "${cmd_bootstrap_all_dir}" ] \
        && printf 'export PATH="%s:$PATH"\n' "${cmd_bootstrap_all_dir}"
    done << EOF >> "${CLAUDE_ENV_FILE}" 2> /dev/null || true
$(required_path_dirs)
EOF
  fi

  reload_or_hint "${RELOAD}"
}
