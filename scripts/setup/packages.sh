# shellcheck shell=sh

cmd_setup_node() {
  cmd_setup_node_package_manager=$(cmd_setup_ensure_package_manager)

  command -v bash > /dev/null 2>&1 || install_packages "${cmd_setup_node_package_manager}" bash

  if [ ! -d "${HOME}/.nvm" ]; then
    log_step "Installing nvm"
    PROFILE=/dev/null bash -c \
      "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash"
    # shellcheck disable=SC2016
    append_shell_rc 'export NVM_DIR="$HOME/.nvm"'
    # shellcheck disable=SC2016
    append_shell_rc '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
    # shellcheck disable=SC2016
    append_shell_rc '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"'
  fi

  cmd_setup_node_nvmrc="${REPO_ROOT}/.nvmrc"
  [ -f "${cmd_setup_node_nvmrc}" ] || die ".nvmrc not found at ${cmd_setup_node_nvmrc}"
  cmd_setup_node_version=$(tr -d '[:space:]' < "${cmd_setup_node_nvmrc}")

  log_step "Installing Node ${cmd_setup_node_version} via nvm"
  NVM_DIR="${HOME}/.nvm" bash -c '
    . "$NVM_DIR/nvm.sh"
    command -v nvm > /dev/null 2>&1 || { echo "nvm function not loaded" >&2; exit 11; }
    nvm install "$1" || exit 12
    nvm alias default "$1" || exit 13
    nvm use "$1" || exit 14
    corepack enable || exit 15
    corepack prepare --activate || exit 16
    node --version || exit 17
    pnpm --version || exit 18
  ' nvm-bootstrap "${cmd_setup_node_version}" || die "nvm/node/pnpm bootstrap failed"

  log_ok "Node ${cmd_setup_node_version} ready via nvm"
  unset cmd_setup_node_package_manager
}

cmd_setup_python() {
  cmd_setup_python_package_manager=$(cmd_setup_ensure_package_manager)

  if command -v uv > /dev/null 2>&1; then
    log_ok "uv already installed: $(uv --version)"
    return 0
  fi

  case "${cmd_setup_python_package_manager}" in
    brew)
      log_step "Installing uv via Homebrew"
      install_packages brew uv
      ;;
    apt-get | pacman)
      log_step "Installing uv via official installer"
      curl -fsSL https://astral.sh/uv/install.sh | sh
      # shellcheck disable=SC2016
      append_shell_rc 'export PATH="$HOME/.local/bin:$PATH"'
      PATH="${HOME}/.local/bin:${PATH}"
      export PATH
      ;;
  esac

  command -v uv > /dev/null 2>&1 || die "uv installation failed"
  log_ok "uv $(uv --version)"
}

cmd_setup_go() {
  cmd_setup_go_package_manager=$(cmd_setup_ensure_package_manager)

  log_step "Installing Go"
  case "${cmd_setup_go_package_manager}" in
    brew) install_packages brew go ;;
    apt-get) install_packages apt-get golang-go ;;
    pacman) install_packages pacman go ;;
  esac

  command -v go > /dev/null 2>&1 || die "go not found after install"
  cmd_setup_go_bin="$(go env GOPATH)/bin"
  append_shell_rc "export PATH=\"${cmd_setup_go_bin}:\$PATH\""
  PATH="${cmd_setup_go_bin}:${PATH}"
  export PATH
  log_ok "$(go version)"
}

cmd_setup_aws() {
  cmd_setup_aws_package_manager=$(cmd_setup_ensure_package_manager)

  if command -v aws > /dev/null 2>&1; then
    cmd_setup_aws_version=$(aws --version 2>&1 | awk '{print $1}')
    case "${cmd_setup_aws_version}" in
      aws-cli/2.*)
        log_ok "awscli v2 already installed: ${cmd_setup_aws_version}"
        return 0
        ;;
      *)
        log_warn "awscli ${cmd_setup_aws_version} detected — replacing with v2"
        ;;
    esac
  fi

  case "${cmd_setup_aws_package_manager}" in
    brew)
      log_step "Installing awscli v2 via Homebrew"
      install_packages brew awscli
      ;;
    apt-get | pacman)
      log_step "Installing awscli v2 via official bundle"
      cmd_setup_aws_arch=$(uname -m)
      case "${cmd_setup_aws_arch}" in
        x86_64) cmd_setup_aws_zip="awscli-exe-linux-x86_64.zip" ;;
        aarch64 | arm64) cmd_setup_aws_zip="awscli-exe-linux-aarch64.zip" ;;
        *) die "Unsupported architecture for awscli v2: ${cmd_setup_aws_arch}" ;;
      esac
      cmd_setup_aws_tmp=$(mktemp -d)
      curl -fsSL "https://awscli.amazonaws.com/${cmd_setup_aws_zip}" -o "${cmd_setup_aws_tmp}/awscliv2.zip"
      unzip -q "${cmd_setup_aws_tmp}/awscliv2.zip" -d "${cmd_setup_aws_tmp}"
      use_sudo "${cmd_setup_aws_tmp}/aws/install" --update
      rm -rf "${cmd_setup_aws_tmp}"
      ;;
  esac

  log_ok "$(aws --version 2>&1)"
}
