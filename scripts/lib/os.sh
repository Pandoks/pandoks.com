# shellcheck shell=sh

#######################################
# Determine normalized operating system name.
# Outputs:
#   macos, debian, fedora, rhel, arch, alpine, linux, windows-posix, windows-native, or unknown
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
#   brew, apt-get, dnf, yum, pacman, apk, winget, scoop, choco, or none
#######################################
get_package_manager() {
  case "$(get_os)" in
    macos)
      command -v brew > /dev/null 2>&1 && echo "brew" || echo "none"
      ;;
    debian)
      command -v apt-get > /dev/null 2>&1 && echo "apt-get" || echo "none"
      ;;
    fedora | rhel)
      if command -v dnf > /dev/null 2>&1; then
        echo "dnf"
      elif command -v yum > /dev/null 2>&1; then
        echo "yum"
      else
        echo "none"
      fi
      ;;
    arch)
      command -v pacman > /dev/null 2>&1 && echo "pacman" || echo "none"
      ;;
    alpine)
      command -v apk > /dev/null 2>&1 && echo "apk" || echo "none"
      ;;
    windows-posix)
      if command -v pacman > /dev/null 2>&1; then
        echo "pacman"
      elif command -v apt-cyg > /dev/null 2>&1; then
        echo "apt-cyg"
      else
        echo "none"
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
        echo "none"
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
        echo "none"
      fi
      ;;
    *)
      echo "none"
      ;;
  esac
}

#######################################
# Determine the user's current shell.
# Outputs:
#   zsh, bash, ksh, fish, ash, dash, sh, or unknown
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
