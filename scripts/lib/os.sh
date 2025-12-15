# shellcheck shell=sh

#######################################
# Determine normalized operating system name.
# Outputs:
#   OS: macos | debian | fedora | rhel | arch | alpine | linux | windows-posix | windows-native | unknown
#######################################
get_os() {
  get_os_uname="$(uname -s 2> /dev/null || echo unknown)"

  case "${get_os_uname}" in
    Darwin)
      echo "macos"
      ;;
    Linux)
      if [ -f /etc/os-release ]; then
        . /etc/os-release
        case "${ID:-}" in
          ubuntu | debian) echo "debian" ;;
          fedora) echo "fedora" ;;
          centos | rhel) echo "rhel" ;;
          arch) echo "arch" ;;
          alpine) echo "alpine" ;;
          *) echo "linux" ;;
        esac
      else
        echo "linux"
      fi
      ;;
    CYGWIN* | MINGW* | MSYS*)
      echo "windows-posix"
      ;;
    Windows_NT)
      echo "windows-native"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

#######################################
# Determine available package manager for current system.
# Outputs:
#   Package Manager: brew | apt-get | dnf | yum | pacman | apk | apt-cyg | winget | scoop | choco | unknown
#######################################
get_package_manager() {
  case "$(get_os)" in
    macos)
      command -v brew > /dev/null 2>&1 && echo "brew" || echo "unknown"
      ;;
    debian)
      command -v apt-get > /dev/null 2>&1 && echo "apt-get" || echo "unknown"
      ;;
    fedora | rhel)
      if command -v dnf > /dev/null 2>&1; then
        echo "dnf"
      elif command -v yum > /dev/null 2>&1; then
        echo "yum"
      else
        echo "unknown"
      fi
      ;;
    arch)
      command -v pacman > /dev/null 2>&1 && echo "pacman" || echo "unknown"
      ;;
    alpine)
      command -v apk > /dev/null 2>&1 && echo "apk" || echo "unknown"
      ;;
    windows-posix)
      if command -v pacman > /dev/null 2>&1; then
        echo "pacman"
      elif command -v apt-cyg > /dev/null 2>&1; then
        echo "apt-cyg"
      else
        echo "unknown"
      fi
      ;;
    windows-native)
      if command -v winget > /dev/null 2>&1; then
        echo "winget"
      elif command -v scoop > /dev/null 2>&1; then
        echo "scoop"
      elif command -v choco > /dev/null 2>&1; then
        echo "choco"
      else
        echo "unknown"
      fi
      ;;
    linux)
      if command -v apt-get > /dev/null 2>&1; then
        echo "apt-get"
      elif command -v dnf > /dev/null 2>&1; then
        echo "dnf"
      elif command -v yum > /dev/null 2>&1; then
        echo "yum"
      elif command -v pacman > /dev/null 2>&1; then
        echo "pacman"
      elif command -v apk > /dev/null 2>&1; then
        echo "apk"
      elif command -v brew > /dev/null 2>&1; then
        echo "brew"
      else
        echo "unknown"
      fi
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

#######################################
# Determine the user's current shell.
# Outputs:
#   Shell: zsh | bash | ksh | fish | ash | dash | sh | unknown
# Returns:
#   0 on success, 1 if SHELL is unset or empty
#######################################
get_shell() {
  get_shell_path="${SHELL:-}"

  if [ -z "${get_shell_path}" ]; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b SHELL environment variable not set\n" "${RED}" "${NORMAL}" >&2
    else
      echo "Error: SHELL environment variable not set" >&2
    fi
    return 1
  fi

  get_shell_name="${get_shell_path##*/}"
  case "${get_shell_name}" in
    zsh | bash | ksh | fish | ash | dash | sh)
      echo "${get_shell_name}"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

#######################################
# Get the RC file path for a given shell.
# Arguments:
#   Shell: zsh | bash | ksh | fish | ash | dash | sh
# Outputs:
#   Path to RC file (e.g., ~/.zshrc)
# Returns:
#   0 on success, 1 if unknown shell or if HOME is unset
#######################################
get_shell_rc_file() {
  get_shell_rc_file_shell="$1"

  if [ -z "${HOME:-}" ]; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b HOME environment variable not set\n" "${RED}" "${NORMAL}" >&2
    else
      echo "Error: HOME environment variable not set" >&2
    fi
    return 1
  fi

  case "${get_shell_rc_file_shell}" in
    zsh)
      echo "${ZDOTDIR:-${HOME}}/.zshrc"
      ;;
    bash)
      if [ -f "${HOME}/.bashrc" ] || [ ! -f "${HOME}/.bash_profile" ]; then
        echo "${HOME}/.bashrc"
      else
        echo "${HOME}/.bash_profile"
      fi
      ;;
    ksh)
      echo "${ENV:-${HOME}/.kshrc}"
      ;;
    fish)
      echo "${XDG_CONFIG_HOME:-${HOME}/.config}/fish/config.fish"
      ;;
    ash | dash | sh)
      echo "${HOME}/.profile"
      ;;
    *)
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b Unknown shell: %s\n" "${RED}" "${NORMAL}" "${get_shell_rc_file_shell}" >&2
      else
        echo "Error: Unknown shell: ${get_shell_rc_file_shell}" >&2
      fi
      return 1
      ;;
  esac
}

#######################################
# Check if the OS is supported.
# Arguments:
#   Shell:  macos | debian | fedora | rhel | arch | alpine | linux | windows-posix | windows-native
# Outputs:
#   Unsupported OS message to STDERR
# Returns:
#   0 if supported, 1 if not
#######################################
is_supported_os() {
  is_supported_os_os="$1"
  case "${is_supported_os_os}" in
    macos | debian | fedora | rhel | arch | alpine | linux | windows-posix)
      return 0
      ;;
    windows-native)
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b Windows is not supported. Use WSL instead.\n" "${RED}" "${NORMAL}" >&2
      else
        echo "Error: Windows is not supported. Use WSL instead." >&2
      fi
      return 1
      ;;
    *)
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b Unsupported OS: %s\n" "${RED}" "${NORMAL}" "${is_supported_os_os}" >&2
      else
        echo "Error: Unsupported OS: ${is_supported_os_os}" >&2
      fi
      return 1
      ;;
  esac
}

#######################################
# Check if the shell is supported.
# Arguments:
#   Shell: zsh | bash | ksh | fish | ash | dash | sh
# Outputs:
#   Unsupported shell message to STDERR
# Returns:
#   0 if supported, 1 if not
#######################################
is_supported_shell() {
  is_supported_shell_shell=$1
  case "${is_supported_shell_shell}" in
    zsh | bash | ksh | ash | dash | sh)
      return 0
      ;;
    fish)
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b Fish is not supported. Use a POSIX shell instead.\n" "${RED}" "${NORMAL}" >&2
      else
        echo "Error: Fish is not supported. Use a POSIX shell instead." >&2
      fi
      return 1
      ;;
    *)
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b Unsupported shell: %s\n" "${RED}" "${NORMAL}" "${is_supported_shell_shell}" >&2
      else
        echo "Error: Unsupported shell: ${is_supported_shell_shell}" >&2
      fi
      return 1
      ;;
  esac
}

#######################################
# Check if the package manager is supported.
# Arguments:
#   Package Manager: brew | apt-get | dnf | yum | pacman | apk | apt-cyg | winget | scoop | choco | unknown
# Outputs:
#   Unsupported package manager message to STDERR
# Returns:
#   0 if supported, 1 if not
#######################################
is_supported_package_manager() {
  is_supported_package_manager_package_manager="$1"
  case "${is_supported_package_manager_package_manager}" in
    brew | apt-get | apt-cyg | dnf | yum | pacman | apk)
      return 0
      ;;
    winget | scoop | choco)
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b %s is not supported. Use WSL or a POSIX environment.\n" "${RED}" "${NORMAL}" "${is_supported_package_manager_package_manager}" >&2
      else
        echo "Error: ${is_supported_package_manager_package_manager} is not supported. Use WSL or a POSIX environment." >&2
      fi
      return 1
      ;;
    *)
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b Unsupported package manager: %s\n" "${RED}" "${NORMAL}" "${is_supported_package_manager_package_manager}" >&2
      else
        echo "Error: Unsupported package manager: ${is_supported_package_manager_package_manager}" >&2
      fi
      return 1
      ;;
  esac
}
