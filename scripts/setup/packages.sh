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
