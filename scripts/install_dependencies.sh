#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
readonly SCRIPT_DIR

. "${SCRIPT_DIR}/lib/font.sh"
. "${SCRIPT_DIR}/lib/os.sh"

install_curl() {
  install_curl_package_manager="$1"

  case "${install_curl_package_manager}" in
    brew) brew install curl ;;
    apt-get) sudo apt-get update && sudo apt-get install -y curl ;;
    dnf | yum) sudo "${install_curl_package_manager}" install -y curl ;;
    pacman) sudo pacman -S --noconfirm curl ;;
    apk) sudo apk add --no-cache curl ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_curl_package_manager}" >&2
      return 1
      ;;
  esac
}

is_nvm_installed() {
  if [ -n "${NVM_DIR:-}" ] && [ -s "${NVM_DIR}/nvm.sh" ]; then
    return 0
  fi

  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    return 0
  fi

  if command -v brew > /dev/null 2>&1; then
    is_nvm_installed_brew_prefix="$(brew --prefix nvm 2> /dev/null || echo '')"
    if [ -n "${is_nvm_installed_brew_prefix}" ] && [ -s "${is_nvm_installed_brew_prefix}/nvm.sh" ]; then
      return 0
    fi
  fi

  return 1
}

install_nvm() {
  install_nvm_shell="$1"
  install_nvm_package_manager="$2"

  case "${install_nvm_package_manager}" in
    brew)
      brew install nvm
      if ! install_nvm_shell_rc_file=$(get_shell_rc_file "${install_nvm_shell}"); then
        return 1
      fi
      if [ ! -d "${HOME}/.nvm" ]; then
        mkdir -p "${HOME}/.nvm"
      fi
      if grep -q 'NVM_DIR' "${install_nvm_shell_rc_file}" 2> /dev/null; then
        echo "NVM_DIR already set in ${install_nvm_shell_rc_file}"
        return 0
      fi
      cat >> "${install_nvm_shell_rc_file}" << 'EOF'

export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix)/opt/nvm/nvm.sh" ] && . "$(brew --prefix)/opt/nvm/nvm.sh"
[ -s "$(brew --prefix)/opt/nvm/etc/bash_completion.d/nvm" ] && . "$(brew --prefix)/opt/nvm/etc/bash_completion.d/nvm"
EOF
      ;;
    pacman)
      sudo pacman -S --noconfirm nvm
      if ! install_nvm_shell_rc_file=$(get_shell_rc_file "${install_nvm_shell}"); then
        return 1
      fi
      if grep -q 'init-nvm.sh' "${install_nvm_shell_rc_file}" 2> /dev/null; then
        echo "init-nvm.sh already set in ${install_nvm_shell_rc_file}"
        return 0
      fi
      echo ". /usr/share/nvm/init-nvm.sh" >> "${install_nvm_shell_rc_file}"
      ;;
    apt-get | dnf | yum | apk)
      if ! command -v bash > /dev/null 2>&1; then
        printf "%bError:%b bash is required to install nvm\n" "${RED}" "${NORMAL}" >&2
        return 1
      fi

      if ! command -v curl > /dev/null 2>&1; then
        install_curl "${install_nvm_package_manager}" || return 1
      fi
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_nvm_package_manager}" >&2
      return 1
      ;;
  esac
}

install_pnpm() {
  install_pnpm_package_manager="$1"

  case "${install_pnpm_package_manager}" in
    brew) brew install pnpm ;;
    pacman) sudo pacman -S --noconfirm pnpm ;;
    apt-get)
      if ! command -v curl > /dev/null 2>&1; then
        install_curl "${install_pnpm_package_manager}" || return 1
      fi
      curl -fsSL https://get.pnpm.io/install.sh | sh -
      ;;
    dnf | yum) sudo "${install_pnpm_package_manager}" install -y pnpm ;;
    apk) sudo apk add --no-cache pnpm ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_pnpm_package_manager}" >&2
      return 1
      ;;
  esac
}

install_golang() {
  install_golang_package_manager="$1"

  case "${install_golang_package_manager}" in
    brew) brew install go ;;
    apt-get) sudo apt-get update && sudo apt-get install -y golang-go ;;
    dnf | yum) sudo "${install_golang_package_manager}" install -y golang ;;
    pacman) sudo pacman -S --noconfirm go ;;
    apk) sudo apk add --no-cache go ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_golang_package_manager}" >&2
      return 1
      ;;
  esac
}

install_docker() {
  install_docker_package_manager="$1"

  case "${install_docker_package_manager}" in
    brew) brew install --cask docker-desktop ;;
    apt-get)
      sudo apt-get update
      sudo apt-get install -y docker.io
      sudo systemctl enable docker
      sudo systemctl start docker
      ;;
    dnf | yum)
      sudo "${install_docker_package_manager}" install -y moby-engine
      sudo systemctl enable docker
      sudo systemctl start docker
      ;;
    pacman)
      sudo pacman -S --noconfirm docker
      sudo systemctl enable docker
      sudo systemctl start docker
      ;;
    apk)
      sudo apk add --no-cache docker
      sudo rc-update add docker boot
      sudo rc-service docker start
      ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_docker_package_manager}" >&2
      return 1
      ;;
  esac
}

install_kubectl() {
  install_kubectl_package_manager="$1"

  case "${install_kubectl_package_manager}" in
    brew) brew install kubectl ;;
    apt-get)
      sudo apt-get update
      sudo apt-get install -y apt-transport-https ca-certificates gnupg

      if ! command -v curl > /dev/null 2>&1; then
        install_curl "${install_kubectl_package_manager}" || return 1
      fi
      curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.34/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
      sudo chmod 644 /etc/apt/keyrings/kubernetes-apt-keyring.gpg
      echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list
      sudo chmod 644 /etc/apt/sources.list.d/kubernetes.list

      sudo apt-get update
      sudo apt-get install -y kubectl
      ;;
    dnf | yum)
      cat << EOF | sudo tee /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v1.34/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v1.34/rpm/repodata/repomd.xml.key
EOF
      sudo "${install_kubectl_package_manager}" install -y kubectl
      ;;
    pacman) sudo pacman -S --noconfirm kubectl ;;
    apk) sudo apk add --no-cache kubectl ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_kubectl_package_manager}" >&2
      return 1
      ;;
  esac
}

install_helm() {
  install_helm_package_manager="$1"

  case "${install_helm_package_manager}" in
    brew) brew install helm ;;
    apt-get)
      sudo apt-get update
      sudo apt-get install -y gpg apt-transport-https

      if ! command -v curl > /dev/null 2>&1; then
        install_curl "${install_helm_package_manager}" || return 1
      fi
      curl -fsSL https://packages.buildkite.com/helm-linux/helm-debian/gpgkey | gpg --dearmor | sudo tee /usr/share/keyrings/helm.gpg > /dev/null
      echo "deb [signed-by=/usr/share/keyrings/helm.gpg] https://packages.buildkite.com/helm-linux/helm-debian/any/ any main" | sudo tee /etc/apt/sources.list.d/helm-stable-debian.list

      sudo apt-get update
      sudo apt-get install -y helm
      ;;
    dnf | yum) sudo "${install_helm_package_manager}" install -y helm ;;
    pacman) sudo pacman -S --noconfirm helm ;;
    apk) sudo apk add --no-cache helm ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_helm_package_manager}" >&2
      return 1
      ;;
  esac
}

install_k3d() {
  install_k3d_package_manager="$1"

  case "${install_k3d_package_manager}" in
    brew) brew install k3d ;;
    pacman | apt-get | dnf | yum | apk)
      if ! command -v bash > /dev/null 2>&1; then
        printf "%bError:%b bash is required to install k3d\n" "${RED}" "${NORMAL}" >&2
        return 1
      fi
      if ! command -v curl > /dev/null 2>&1; then
        install_curl "${install_k3d_package_manager}" || return 1
      fi
      curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
      ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_k3d_package_manager}" >&2
      return 1
      ;;
  esac
}

install_awscli() {
  install_awscli_package_manager="$1"

  case "${install_awscli_package_manager}" in
    brew) brew install awscli ;;
    apt-get) sudo apt-get update && sudo apt-get install -y awscli ;;
    dnf | yum) sudo "${install_awscli_package_manager}" install -y awscli2 ;;
    pacman) sudo pacman -S --noconfirm aws-cli-v2 ;;
    apk) sudo apk add --no-cache aws-cli ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_awscli_package_manager}" >&2
      return 1
      ;;
  esac
}

main() {
  os="$(get_os)"
  is_supported_os "${os}" || return 1
  printf "Detected OS: %b${os}%b\n" "${BOLD}" "${NORMAL}"

  shell="$(get_shell)"
  is_supported_shell "${shell}" || return 1
  printf "Detected shell: %b${shell}%b\n" "${BOLD}" "${NORMAL}"

  package_manager="$(get_package_manager)"
  is_supported_package_manager "${package_manager}" || return 1
  printf "Detected package manager: %b${package_manager}%b\n" "${BOLD}" "${NORMAL}"

  if is_nvm_installed; then
    printf "%b✓ nvm is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_nvm "${shell}" "${package_manager}" || return 1
  fi
  nvm_dir="${NVM_DIR:-${HOME}/.nvm}"
  if [ -s "${nvm_dir}/nvm.sh" ]; then
    export NVM_DIR="${nvm_dir}"
    . "${nvm_dir}/nvm.sh"
  elif [ -s "/usr/share/nvm/init-nvm.sh" ]; then
    . "/usr/share/nvm/init-nvm.sh"
  elif command -v brew > /dev/null 2>&1 && [ -s "$(brew --prefix nvm 2> /dev/null)/nvm.sh" ]; then
    export NVM_DIR="${nvm_dir}"
    . "$(brew --prefix nvm)/nvm.sh"
  else
    printf "%bError:%b Could not find nvm to source\n" "${RED}" "${NORMAL}" >&2
    return 1
  fi
  nvm install

  if command -v pnpm > /dev/null 2>&1; then
    printf "%b✓ pnpm is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_pnpm "${package_manager}" || return 1
  fi

  if command -v go > /dev/null 2>&1; then
    printf "%b✓ go is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_golang "${package_manager}" || return 1
  fi

  if command -v docker > /dev/null 2>&1; then
    printf "%b✓ docker is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_docker "${package_manager}" || return 1
  fi

  if command -v kubectl > /dev/null 2>&1; then
    printf "%b✓ kubectl is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_kubectl "${package_manager}" || return 1
  fi

  if command -v helm > /dev/null 2>&1; then
    printf "%b✓ helm is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_helm "${package_manager}" || return 1
  fi

  if command -v k3d > /dev/null 2>&1; then
    printf "%b✓ k3d is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_k3d "${package_manager}" || return 1
  fi

  if command -v aws > /dev/null 2>&1; then
    printf "%b✓ aws is already installed%b\n" "${GREEN}" "${NORMAL}"
  else
    install_awscli "${package_manager}" || return 1
  fi
}

main
