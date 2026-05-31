# shellcheck shell=sh

# renovate: datasource=github-releases packageName=helm/helm
HELM_VERSION=v4.2.0

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

all_tools_present_in_path() {
  for all_present_tool in "$@"; do
    command -v "${all_present_tool}" > /dev/null 2>&1 || return 1
  done
}

install_helm() {
  install_helm_arch=$(architecture_asset amd64 arm64)
  install_helm_tmp=$(mktemp -d)
  log_step "Installing helm ${HELM_VERSION} via official tarball"
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${install_helm_arch}.tar.gz" \
    -o "${install_helm_tmp}/helm.tar.gz"
  tar -xzf "${install_helm_tmp}/helm.tar.gz" -C "${install_helm_tmp}"
  use_sudo install -m 0755 "${install_helm_tmp}/linux-${install_helm_arch}/helm" /usr/local/bin/helm
  rm -rf "${install_helm_tmp}"
}

install_k3d() {
  log_step "Installing k3d via official installer"
  curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | use_sudo bash
}

install_node() {
  [ -f "${REPO_ROOT}/.nvmrc" ] || die ".nvmrc not found at ${REPO_ROOT}/.nvmrc"
  install_node_version=$(read_nvmrc)

  # Short circuit if detected version exists on plate instead of sourcing from nvm.sh to use cli
  for install_node_dir in "${HOME}"/.nvm/versions/node/v"${install_node_version}".*/bin; do
    if [ -d "${install_node_dir}" ]; then
      log_ok "Node ${install_node_version} already installed via nvm"
      return 0
    fi
  done

  if [ -d "${HOME}/.nvm" ] && NVM_DIR="${HOME}/.nvm" bash -c "
    . \"\$NVM_DIR/nvm.sh\" 2> /dev/null
    nvm version \"${install_node_version}\" > /dev/null 2>&1
  "; then
    log_ok "Node ${install_node_version} already installed via nvm"
    return 0
  fi

  install_node_package_manager=$(ensure_package_manager)
  command -v bash > /dev/null 2>&1 || install_packages "${install_node_package_manager}" bash

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

  install_node_pnpm_pin=$(pnpm_spec)

  log_step "Installing Node ${install_node_version} via nvm"
  # NOTE: nvm has to run via bash (not posix sh)
  NVM_DIR="${HOME}/.nvm" bash -c '
    set -e
    . "$NVM_DIR/nvm.sh"
    nvm install "$1"
    nvm alias default "$1"
    nvm use "$1"
    corepack enable
    corepack prepare "${2:-pnpm@latest}" --activate
  ' nvm-bootstrap "${install_node_version}" "${install_node_pnpm_pin}" || die "nvm/node/pnpm bootstrap failed"

  log_ok "Node ${install_node_version} ready via nvm"
  # shellcheck disable=SC2016
  log_warn 'Activate in this shell: export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use '"${install_node_version}"
}

install_python() {
  if command -v uv > /dev/null 2>&1; then
    log_ok "uv already installed: $(uv --version)"
    return 0
  fi

  install_python_package_manager=$(ensure_package_manager)
  case "${install_python_package_manager}" in
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
      # shellcheck disable=SC2016
      log_warn 'Activate in this shell: export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac

  command -v uv > /dev/null 2>&1 || die "uv installation failed"
  log_ok "uv $(uv --version)"
}

install_go() {
  if command -v go > /dev/null 2>&1; then
    log_ok "Go already installed: $(go version)"
    return 0
  fi

  install_go_package_manager=$(ensure_package_manager)
  log_step "Installing Go"
  case "${install_go_package_manager}" in
    brew) install_packages brew go ;;
    apt-get) install_packages apt-get golang-go ;;
    pacman) install_packages pacman go ;;
  esac

  command -v go > /dev/null 2>&1 || die "go not found after install"
  install_go_bin="$(go env GOPATH)/bin"
  append_shell_rc "export PATH=\"${install_go_bin}:\$PATH\""
  PATH="${install_go_bin}:${PATH}"
  export PATH
  log_ok "$(go version)"
  log_warn "Activate in this shell: export PATH=\"${install_go_bin}:\$PATH\""
}

install_aws() {
  install_aws_have=$(aws --version 2>&1 | awk '{print $1}')
  case "${install_aws_have}" in
    aws-cli/2.*)
      log_ok "awscli v2 already installed: ${install_aws_have}"
      ;;
    *)
      install_aws_package_manager=$(ensure_package_manager)
      case "${install_aws_package_manager}" in
        brew)
          log_step "Installing awscli v2 via Homebrew"
          install_packages brew awscli
          ;;
        apt-get | pacman)
          log_step "Installing awscli v2 via official bundle"
          install_aws_zip=$(architecture_asset awscli-exe-linux-x86_64.zip awscli-exe-linux-aarch64.zip)
          install_aws_tmp=$(mktemp -d)
          curl -fsSL "https://awscli.amazonaws.com/${install_aws_zip}" -o "${install_aws_tmp}/awscliv2.zip"
          unzip -q "${install_aws_tmp}/awscliv2.zip" -d "${install_aws_tmp}"
          use_sudo "${install_aws_tmp}/aws/install" --update
          rm -rf "${install_aws_tmp}"
          ;;
      esac
      log_ok "$(aws --version 2>&1)"
      ;;
  esac

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
      fetch_pgp_key \
        https://download.docker.com/linux/ubuntu/gpg \
        /etc/apt/keyrings/docker.gpg \
        "docker"
      use_sudo chmod a+r /etc/apt/keyrings/docker.gpg
      install_docker_arch=$(architecture_asset amd64 arm64)
      install_docker_codename=$(. /etc/os-release && echo "${VERSION_CODENAME}") # NOTE: os-release defines VERSION_CODENAME
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
        "${install_docker_arch}" "${install_docker_codename}" \
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

install_kubernetes() {
  if all_tools_present_in_path kubectl helm k3d kubeconform docker \
    && [ -z "$(version_drift kubectl "$(kubectl version --client --output=yaml 2> /dev/null | awk '/gitVersion/ {print $2; exit}')")" ] \
    && [ -z "$(version_drift helm "$(helm version --short 2> /dev/null)")" ]; then
    log_ok "Cluster tools already installed (kubectl, helm, k3d, kubeconform, docker)"
    return 0
  fi

  install_cluster_package_manager=$(ensure_package_manager)

  install_docker

  log_step "Installing kubectl, k3d, helm"
  case "${install_cluster_package_manager}" in
    brew)
      install_packages brew kubectl k3d helm
      ;;
    apt-get)
      use_sudo install -m 0755 -d /etc/apt/keyrings
      install_cluster_kube_minor="v$(kubectl_pinned_minor)"
      [ "${install_cluster_kube_minor}" != "v" ] || die "Could not read KUBECTL_VERSION from packages/argocd/Dockerfile"

      fetch_pgp_key \
        "https://pkgs.k8s.io/core:/stable:/${install_cluster_kube_minor}/deb/Release.key" \
        /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
        "kubernetes"

      printf 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/%s/deb/ /\n' \
        "${install_cluster_kube_minor}" \
        | use_sudo tee /etc/apt/sources.list.d/kubernetes.list > /dev/null

      use_sudo apt-get update -y
      install_packages apt-get kubectl apache2-utils

      install_helm
      install_k3d
      ;;
    pacman)
      install_packages pacman kubectl apache
      install_helm
      install_k3d
      ;;
  esac

  log_step "Installing kubeconform via go install"
  GO111MODULE=on go install github.com/yannh/kubeconform/cmd/kubeconform@latest

  log_ok "kubectl $(kubectl version --client --output=yaml 2> /dev/null | awk '/gitVersion/ {print $2; exit}')"
  log_ok "k3d $(k3d version 2> /dev/null | awk '/k3d version/ {print $3; exit}')"
  log_ok "helm $(helm version --short 2> /dev/null)"
}

cmd_setup_quality() {
  if command -v shellcheck > /dev/null 2>&1 \
    && command -v shfmt > /dev/null 2>&1 \
    && command -v hadolint > /dev/null 2>&1 \
    && command -v actionlint > /dev/null 2>&1 \
    && command -v golangci-lint > /dev/null 2>&1 \
    && command -v govulncheck > /dev/null 2>&1 \
    && command -v jq > /dev/null 2>&1 \
    && command -v openssl > /dev/null 2>&1; then
    log_ok "Quality tools already installed (shellcheck, shfmt, hadolint, actionlint, golangci-lint, govulncheck, jq, openssl)"
    return 0
  fi

  cmd_setup_quality_package_manager=$(cmd_setup_ensure_package_manager)

  log_step "Installing shellcheck, shfmt, hadolint, jq, openssl"
  case "${cmd_setup_quality_package_manager}" in
    brew)
      install_packages brew \
        shellcheck \
        shfmt \
        hadolint \
        actionlint \
        golangci-lint \
        jq \
        openssl@3
      ;;
    apt-get)
      install_packages apt-get \
        shellcheck \
        shfmt \
        jq \
        openssl
      log_step "Installing hadolint binary (no apt package)"
      cmd_setup_quality_arch=$(uname -m)
      case "${cmd_setup_quality_arch}" in
        x86_64) cmd_setup_quality_hadolint_asset="hadolint-Linux-x86_64" ;;
        aarch64 | arm64) cmd_setup_quality_hadolint_asset="hadolint-Linux-arm64" ;;
        *) die "Unsupported architecture for hadolint: ${cmd_setup_quality_arch}" ;;
      esac
      use_sudo curl -fsSL \
        "https://github.com/hadolint/hadolint/releases/latest/download/${cmd_setup_quality_hadolint_asset}" \
        -o /usr/local/bin/hadolint
      use_sudo chmod +x /usr/local/bin/hadolint

      command -v go > /dev/null 2>&1 || cmd_setup_go
      log_step "Installing actionlint and golangci-lint via go install"
      GO111MODULE=on go install github.com/rhysd/actionlint/cmd/actionlint@latest
      GO111MODULE=on go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
      ;;
    pacman)
      install_packages pacman \
        shellcheck \
        shfmt \
        jq \
        openssl
      log_step "Installing hadolint binary (Arch ships it in AUR only)"
      cmd_setup_quality_arch=$(uname -m)
      case "${cmd_setup_quality_arch}" in
        x86_64) cmd_setup_quality_hadolint_asset="hadolint-Linux-x86_64" ;;
        aarch64 | arm64) cmd_setup_quality_hadolint_asset="hadolint-Linux-arm64" ;;
        *) die "Unsupported architecture for hadolint: ${cmd_setup_quality_arch}" ;;
      esac
      use_sudo curl -fsSL \
        "https://github.com/hadolint/hadolint/releases/latest/download/${cmd_setup_quality_hadolint_asset}" \
        -o /usr/local/bin/hadolint
      use_sudo chmod +x /usr/local/bin/hadolint

      command -v go > /dev/null 2>&1 || cmd_setup_go
      GO111MODULE=on go install github.com/rhysd/actionlint/cmd/actionlint@latest
      GO111MODULE=on go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
      ;;
  esac

  command -v go > /dev/null 2>&1 || cmd_setup_go
  log_step "Installing govulncheck via go install"
  GO111MODULE=on go install golang.org/x/vuln/cmd/govulncheck@latest

  log_ok "Quality tools installed"
}

cmd_setup_all() {
  cmd_setup_node
  cmd_setup_python
  cmd_setup_go
  cmd_setup_aws
  cmd_setup_cluster
  cmd_setup_quality
  if [ "${SETUP_INSTALLED_NODE}" -eq 0 ] \
    && [ "${SETUP_INSTALLED_UV}" -eq 0 ] \
    && [ "${SETUP_INSTALLED_GO}" -eq 0 ]; then
    log_ok "All dependencies already installed"
  else
    cmd_setup_check
  fi
  printf "\n" >&2
  log_ok "Setup complete."
  cmd_setup_print_next_steps
}

cmd_setup_check_report_to() {
  cmd_setup_check_report_to_out="$1"
  cmd_setup_check_report_to_name="$2"
  cmd_setup_check_report_to_cmd="$3"
  if command -v "${cmd_setup_check_report_to_name}" > /dev/null 2>&1; then
    printf "  %b✓%b %-14s %s\n" "${GREEN}" "${NORMAL}" "${cmd_setup_check_report_to_name}" \
      "$(eval "${cmd_setup_check_report_to_cmd}" 2>&1 | head -n1)" > "${cmd_setup_check_report_to_out}"
  else
    printf "  %b✗%b %-14s not installed\n" "${RED}" "${NORMAL}" "${cmd_setup_check_report_to_name}" \
      > "${cmd_setup_check_report_to_out}"
  fi
}

cmd_setup_check() {
  log_step "Detected versions"

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
    cmd_setup_check_name="${cmd_setup_check_spec%%|*}"
    cmd_setup_check_cmd="${cmd_setup_check_spec#*|}"
    cmd_setup_check_report_to \
      "${cmd_setup_check_tmp}/$(printf '%02d' "${cmd_setup_check_i}")" \
      "${cmd_setup_check_name}" \
      "${cmd_setup_check_cmd}" &
    cmd_setup_check_i=$((cmd_setup_check_i + 1))
  done
  wait

  for cmd_setup_check_f in "${cmd_setup_check_tmp}"/*; do
    cat "${cmd_setup_check_f}" >&2
  done
  rm -rf "${cmd_setup_check_tmp}"
}
