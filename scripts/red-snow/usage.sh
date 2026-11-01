# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s <command>\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage the RED-SNOW DeepInfra deployment. Reads DEEPINFRA_API_KEY from the environment.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bup%b        Create the deployment (first load takes ~12 min)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bwake%b      Scale an existing deployment to 1 instance\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bsleep%b     Scale the deployment to zero (stops billing)\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bstatus%b    Show deploy id, status, and min_instances\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %blogs%b      Print the last 30 minutes of deployment logs\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bdelete%b    Delete the deployment\n\n" "${GREEN}" "${NORMAL}" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  DEEPINFRA_API_KEY=... %s up\n" "$0" >&2
  printf "  DEEPINFRA_API_KEY=... %s status\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_error() {
  log_error "$1"
  printf "\n" >&2
  usage 1
}
