# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s <command>\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Install monorepo dependencies on a fresh machine.\n\n" >&2
  printf "Supports: macOS (brew), Ubuntu/Debian (apt-get), Arch (pacman).\n" >&2
  printf "Assumes only that git is installed and the repo is cloned.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %ball%b        Install everything (base + cluster + quality)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bbase%b       Install package manager + language runtimes (node, python, go, aws)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bnode%b       Install nvm + Node from .nvmrc + activate pnpm via corepack\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bpython%b     Install uv (manages Python versions + venvs)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bgo%b         Install Go toolchain\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %baws%b        Install awscli v2 (never v1)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bdocker%b     Install Docker Engine + Compose plugin\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bcluster%b    Install kubectl + k3d + helm + kubeconform (implies docker)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bquality%b    Install lint/format toolchain (shellcheck, shfmt, hadolint, actionlint, golangci-lint, govulncheck)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bcheck%b      Print detected versions for every dependency\n\n" "${GREEN}" "${NORMAL}" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s all\n" "$0" >&2
  printf "  %s base\n" "$0" >&2
  printf "  %s cluster\n" "$0" >&2
  printf "  %s check\n\n" "$0" >&2

  exit "${1:-0}"
}
