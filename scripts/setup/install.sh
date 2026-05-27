cmd_setup_ensure_package_manager() { # Outputs: package manager name (brew | apt-get | pacman)
  cmd_setup_ensure_package_manager_os=$(get_os)
  is_supported_os "${cmd_setup_ensure_package_manager_os}" || exit 1

  {
    case "${cmd_setup_ensure_package_manager_os}" in
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
        die "Setup script does not yet support OS: ${cmd_setup_ensure_package_manager_os}"
        ;;
    esac
  } 1>&2

  cmd_setup_ensure_package_manager_package_manager=$(get_package_manager)
  is_supported_package_manager "${cmd_setup_ensure_package_manager_package_manager}" || exit 1
  printf '%s' "${cmd_setup_ensure_package_manager_package_manager}"
}
