# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s [command]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Install monorepo dependencies on a fresh machine.\n" >&2
  printf "Supports: macOS (brew), Ubuntu/Debian (apt-get), Arch (pacman).\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %ball%b [--reload]  Install everything. On a first install mise is wired into\n" "${GREEN}" "${NORMAL}" >&2
  printf "                 your shell rc; by default the activation one-liner is printed.\n" >&2
  printf "                 %b--reload%b restarts your shell so mise is live immediately\n" "${BOLD}" "${NORMAL}" >&2
  printf "                 (interactive ttys only — ignored under the hook / CI).\n" >&2
  printf "  %bcheck%b         Verify mise bootstrap state, PATH wiring, and system tools; exit non-zero on any problem\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bhelp%b          Show this help\n\n" "${GREEN}" "${NORMAL}" >&2

  exit "${1:-0}"
}
