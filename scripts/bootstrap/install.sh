# shellcheck shell=sh

detect_architecture() {
  case "$(uname -m)" in
    x86_64) printf 'x86_64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
}

architecture_asset() {
  x86_64_asset="$1" # e.g. awscli-exe-linux-x86_64.zip
  arm64_asset="$2"  # e.g. awscli-exe-linux-aarch64.zip
  case "$(detect_architecture)" in
    x86_64) printf '%s' "${x86_64_asset}" ;;
    arm64) printf '%s' "${arm64_asset}" ;;
  esac
}



}

}


    return 0
  fi
}

      ;;
    apt-get)
      ;;
  esac

}


  install_aws_config_dir="${HOME}/.aws"
  install_aws_config_file="${install_aws_config_dir}/config"

  if [ -s "${install_aws_config_file}" ]; then
    log_ok "AWS config already present (~/.aws/config)"
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
  log_ok "Wrote ~/.aws/config (SSO session + 3 profiles)"
}

install_docker() {
  if command -v docker > /dev/null 2>&1; then
    log_ok "Docker already installed: $(docker --version)"
    return 0
  fi

  install_docker_package_manager=$(ensure_package_manager)
  case "${install_docker_package_manager}" in
    brew)
      log_step "Installing Docker Desktop via Homebrew cask"
      brew install --cask docker
      log_warn "Open Docker Desktop once so the engine daemon starts"
      ;;
    apt-get)
      log_step "Installing Docker Engine from docker.com apt repo"
      use_sudo install -m 0755 -d /etc/apt/keyrings
      # Docker serves separate ubuntu/ and debian/ apt repos; ID picks the right one.
      install_docker_distro=$(. /etc/os-release && [ "${ID:-}" = debian ] && echo debian || echo ubuntu) # NOTE: os-release defines ID
      fetch_pgp_key \
        "https://download.docker.com/linux/${install_docker_distro}/gpg" \
        /etc/apt/keyrings/docker.gpg \
        "docker"
      use_sudo chmod a+r /etc/apt/keyrings/docker.gpg
      install_docker_arch=$(architecture_asset amd64 arm64)
      install_docker_codename=$(. /etc/os-release && echo "${VERSION_CODENAME}") # NOTE: os-release defines VERSION_CODENAME
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
        "${install_docker_arch}" "${install_docker_distro}" "${install_docker_codename}" \
        | use_sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
      use_sudo apt-get update -y
      install_packages apt-get \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin
      use_sudo usermod -aG docker "$(id -un)"
      log_warn "Log out + back in for the 'docker' group membership to take effect"
      ;;
    pacman)
      install_packages pacman docker docker-compose docker-buildx
      use_sudo systemctl enable --now docker.service
      use_sudo usermod -aG docker "$(id -un)"
      log_warn "Log out + back in for the 'docker' group membership to take effect"
      ;;
  esac

  log_ok "Docker installed"
}

  fi

  fi







cmd_setup_all() {
  printf "\n" >&2
  log_ok "Setup complete. Run 'setup check' to inventory versions / detect drift."
  print_next_steps

  if [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    while read -r cmd_setup_all_dir; do
      # shellcheck disable=SC2016
      [ -n "${cmd_setup_all_dir}" ] \
        && printf 'export PATH="%s:$PATH"\n' "${cmd_setup_all_dir}"
    done << EOF >> "${CLAUDE_ENV_FILE}" 2> /dev/null || true
$(required_path_dirs)
EOF
  fi
}
