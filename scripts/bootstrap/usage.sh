# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s [command]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Install monorepo dependencies on a fresh machine.\n" >&2
  printf "Supports: macOS (brew), Ubuntu/Debian (apt-get), Arch (pacman).\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %ball%b [--global] [--reload]  Install everything. By default mise tools are\n" "${GREEN}" "${NORMAL}" >&2
  printf "                            active only in this repository.\n" >&2
  printf "                 %b--global%b  Install [_.global_tools] into the current user's\n" "${BOLD}" "${NORMAL}" >&2
  printf "                           global mise config for use from any directory.\n" >&2
  printf "                 %b--reload%b  Restart the shell so mise is live immediately\n" "${BOLD}" "${NORMAL}" >&2
  printf "                           (interactive ttys only — ignored under hooks / CI).\n" >&2
  printf "  %bcheck%b         Verify mise bootstrap state, PATH wiring, and system tools; exit non-zero on any problem\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bhelp%b          Show this help\n\n" "${GREEN}" "${NORMAL}" >&2

  exit "${1:-0}"
}
