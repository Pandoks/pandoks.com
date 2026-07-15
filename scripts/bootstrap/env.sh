# shellcheck shell=sh

BOOTSTRAP_PACKAGE_MANAGER=""

mise_package_managers_for() {
  case "$1" in
    apt) printf 'apt' ;;
    brew) printf 'brew,brew-cask' ;;
    pacman) printf 'pacman' ;;
    *) return 1 ;;
  esac
}

ensure_package_manager() { # Outputs: package manager ID (brew | apt | pacman)
  if [ -n "${BOOTSTRAP_PACKAGE_MANAGER}" ]; then
    printf '%s' "${BOOTSTRAP_PACKAGE_MANAGER}"
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

  ensure_package_manager_package_manager=$(detect_package_manager)
  is_supported_package_manager "${ensure_package_manager_package_manager}" || exit 1
  BOOTSTRAP_PACKAGE_MANAGER="${ensure_package_manager_package_manager}"
  printf '%s' "${BOOTSTRAP_PACKAGE_MANAGER}"
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

BOOTSTRAP_PATH_DIRS_CACHE=""

required_path_dirs() { # Outputs: paths of tools to add to PATH (one per line \n)
  if [ -z "${BOOTSTRAP_PATH_DIRS_CACHE}" ]; then
    BOOTSTRAP_PATH_DIRS_CACHE=$(
      printf '%s\n' "${HOME}/.local/share/mise/shims"
      if [ -x "${HOME}/.local/bin/mise" ]; then
        printf '%s\n' "${HOME}/.local/bin"
      fi
    )
  fi
  printf '%s\n' "${BOOTSTRAP_PATH_DIRS_CACHE}"
}

# needed for non-interactive shells (CI / wrappers / Claude Code Cloud)
populate_proper_pathing() {
  while read -r populate_proper_pathing_dir; do
    [ -n "${populate_proper_pathing_dir}" ] \
      && PATH="${populate_proper_pathing_dir}:${PATH}"
  done << EOF
$(required_path_dirs)
EOF
  export PATH
}
