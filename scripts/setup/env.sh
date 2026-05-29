# shellcheck shell=sh

append_shell_rc() {
  append_shell_rc_line="$1" # Line to add

  if [ -z "${SHELL:-}" ]; then
    log_warn "SHELL not set — add this to your rc file manually: ${append_shell_rc_line}"
    return 0
  fi

  append_shell_rc_shell=$(get_shell 2> /dev/null) || {
    log_warn "Could not detect shell — add manually: ${append_shell_rc_line}"
    return 0
  }
  is_supported_shell "${append_shell_rc_shell}" 2> /dev/null || {
    log_warn "Unsupported shell — add manually: ${append_shell_rc_line}"
    return 0
  }
  append_shell_rc_file=$(get_shell_rc_file "${append_shell_rc_shell}" 2> /dev/null) || {
    log_warn "Could not resolve rc file — add manually: ${append_shell_rc_line}"
    return 0
  }

  [ -f "${append_shell_rc_file}" ] || touch "${append_shell_rc_file}"
  if ! grep -Fqx "${append_shell_rc_line}" "${append_shell_rc_file}"; then
    printf '%s\n' "${append_shell_rc_line}" >> "${append_shell_rc_file}"
  fi
}

SETUP_PACKAGE_MANAGER_CACHE=""

ensure_package_manager() { # Outputs: package manager name (brew | apt-get | pacman)
  if [ -n "${SETUP_PACKAGE_MANAGER_CACHE}" ]; then
    printf '%s' "${SETUP_PACKAGE_MANAGER_CACHE}"
    return 0
  fi

  ensure_package_manager_os=$(get_os)
  is_supported_os "${ensure_package_manager_os}" || exit 1

  # install needed dependencies for basic functionality
  {
    case "${ensure_package_manager_os}" in
      macos)
        if ! xcode-select -p > /dev/null 2>&1; then
          log_step "Installing Xcode Command Line Tools (accept the GUI prompt)"
          xcode-select --install || true
          until xcode-select -p > /dev/null 2>&1; do
            sleep 5
          done
        fi
        if ! command -v brew > /dev/null 2>&1; then
          log_step "Installing Homebrew"
          NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
          if [ -x /opt/homebrew/bin/brew ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
          elif [ -x /usr/local/bin/brew ]; then
            eval "$(/usr/local/bin/brew shellenv)"
          fi
        fi
        ;;
      debian)
        log_step "Refreshing apt-get and installing build prerequisites"
        use_sudo apt-get update -y
        use_sudo apt-get install -y \
          ca-certificates \
          curl \
          gnupg \
          lsb-release \
          unzip \
          build-essential
        ;;
      arch)
        log_step "Refreshing pacman and installing build prerequisites"
        use_sudo pacman -Syu --noconfirm
        use_sudo pacman -S --noconfirm --needed \
          base-devel \
          ca-certificates \
          curl \
          unzip
        ;;
      *)
        die "Setup script does not yet support OS: ${ensure_package_manager_os}"
        ;;
    esac
  } 1>&2

  ensure_package_manager_package_manager=$(get_package_manager)
  is_supported_package_manager "${ensure_package_manager_package_manager}" || exit 1
  SETUP_PACKAGE_MANAGER_CACHE="${ensure_package_manager_package_manager}"
  printf '%s' "${SETUP_PACKAGE_MANAGER_CACHE}"
}

# fetches/installs signing key apt needs to trust third party repos (so we can install packages from them)
fetch_pgp_key() {
  fetch_pgp_key_url="$1"  # URL of armored key
  fetch_pgp_key_dest="$2" # Output path for dearmored key (sudo-writable)
  fetch_pgp_key_name="$3" # Human-readable name (for error messages)

  fetch_pgp_key_attempt=1
  while [ "${fetch_pgp_key_attempt}" -le 3 ]; do
    fetch_pgp_key_tmp=$(mktemp)
    if curl -fsSL --retry 2 --retry-delay 2 \
      "${fetch_pgp_key_url}" \
      -o "${fetch_pgp_key_tmp}" \
      && [ -s "${fetch_pgp_key_tmp}" ] \
      && head -1 "${fetch_pgp_key_tmp}" | grep -q "BEGIN PGP PUBLIC KEY BLOCK"; then
      use_sudo gpg --batch --yes --dearmor \
        -o "${fetch_pgp_key_dest}" \
        < "${fetch_pgp_key_tmp}"
      rm -f "${fetch_pgp_key_tmp}"
      return 0
    fi
    rm -f "${fetch_pgp_key_tmp}"
    log_warn "Fetch of ${fetch_pgp_key_name} key failed (attempt ${fetch_pgp_key_attempt}/3) — retrying"
    fetch_pgp_key_attempt=$((fetch_pgp_key_attempt + 1))
    sleep 3
  done
  die "Failed to fetch ${fetch_pgp_key_name} PGP key from ${fetch_pgp_key_url} after 3 attempts"
}

read_nvmrc() { # Outputs: node version inside .nvmrc
  tr -d '[:space:]' < "${REPO_ROOT}/.nvmrc"
}

required_path_dirs() { # Outputs: paths of tools to add to PATH (one per line \n)
  # shellcheck disable=SC2012
  required_path_dirs_node=$(ls -d "${HOME}"/.nvm/versions/node/v"$(read_nvmrc)".*/bin \
    2> /dev/null | sort -V | tail -n1)
  [ -n "${required_path_dirs_node}" ] && printf '%s\n' "${required_path_dirs_node}"
  [ -x "${HOME}/.local/bin/uv" ] && printf '%s\n' "${HOME}/.local/bin"
  command -v go > /dev/null 2>&1 && printf '%s\n' "$(go env GOPATH)/bin"
}

# needed for non-interactive shells (CI / wrappers / Claude Code Cloud)
populate_proper_pathing() {
  populate_proper_pathing_node=$(nvm_node_path)
  [ -n "${populate_proper_pathing_node}" ] && PATH="${populate_proper_pathing_node}:${PATH}"
  [ -x "${HOME}/.local/bin/uv" ] && PATH="${HOME}/.local/bin:${PATH}"
  command -v go > /dev/null 2>&1 && PATH="$(go env GOPATH)/bin:${PATH}"
  export PATH
}
