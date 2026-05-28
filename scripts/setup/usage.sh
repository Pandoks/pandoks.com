# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s [command]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Install monorepo dependencies on a fresh machine.\n" >&2
  printf "Supports: macOS (brew), Ubuntu/Debian (apt-get), Arch (pacman).\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %ball%b      Install everything (default when no command is given)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bcheck%b    Print detected versions; exit non-zero if anything is missing or version-drifted\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bhelp%b     Show this help\n\n" "${GREEN}" "${NORMAL}" >&2

  exit "${1:-0}"
}
