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

      if command -v wget > /dev/null 2>&1; then
        wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      elif command -v curl > /dev/null 2>&1; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      else
        install_curl "${install_nvm_package_manager}" || return 1
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      fi
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
      if command -v wget > /dev/null 2>&1; then
        wget -qO- https://get.pnpm.io/install.sh | sh -
      elif command -v curl > /dev/null 2>&1; then
        curl -fsSL https://get.pnpm.io/install.sh | sh -
      else
        install_curl "${install_pnpm_package_manager}" || return 1
        curl -fsSL https://get.pnpm.io/install.sh | sh -
      fi
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

install_k3d() {
  install_k3d_package_manager="$1"

  case "${install_k3d_package_manager}" in
    brew) brew install k3d ;;
    pacman | apt-get | dnf | yum | apk)
      if ! command -v bash > /dev/null 2>&1; then
        printf "%bError:%b bash is required to install k3d\n" "${RED}" "${NORMAL}" >&2
        return 1
      fi
      if command -v wget > /dev/null 2>&1; then
        wget -q -O - https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
      elif command -v curl > /dev/null 2>&1; then
        curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
      else
        install_curl "${install_k3d_package_manager}" || return 1
        curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
      fi
      ;;
    *)
      printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${install_k3d_package_manager}" >&2
      return 1
      ;;
  esac
}

#######################################
# Install awscli via package manager or curl installer.
# Arguments:
#   OS
#   Package manager
# Returns:
#   0 on success, 1 on failure
#######################################
install_awscli() {
  install_awscli_package_manager="$1"

  case "${install_awscli_package_manager}" in
    brew) brew install awscli ;;
    apt-get) sudo apt-get update && sudo apt-get install -y awscli ;;
    dnf | yum) sudo "${install_awscli_package_manager}" install -y awscli ;;
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
