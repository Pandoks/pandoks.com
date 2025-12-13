#!/bin/sh
set -eu

get_os() {
  os="$(uname -s 2>/dev/null || echo unknown)"

  case "${os}" in
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
  CYGWIN* | MINGW* | MSYS* | Windows_NT)
    echo "windows"
    ;;
  *)
    echo "unknown"
    ;;
  esac
}
