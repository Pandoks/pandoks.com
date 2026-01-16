# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s <command> [subcommand] [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage k3d clusters and deploy k3s applications.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bk3d%b             Manage local k3d cluster and dependencies\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Subcommands: up, down, start, stop, restart, deps\n\n" >&2

  printf "  %bsetup%b           Setup cluster with addons and manifests\n" "${GREEN}" "${NORMAL}" >&2
  printf "      (prompts for cluster confirmation)\n\n" >&2

  printf "  %bsst-apply%b      Render SST templates and apply to cluster\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Usage: sst-apply <FILE|all> [--kubeconfig <PATH>]\n\n" >&2

  printf "Run '%s <command> --help' for more information on a command.\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_k3d() {
  printf "%bUsage:%b %s k3d <subcommand>\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage local k3d cluster and dependencies.\n\n" >&2

  printf "%bSubcommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bup%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Create k3d cluster with 3 servers and 3 agents\n" >&2
  printf "      (attaches to pandoks-net docker network)\n\n" >&2

  printf "  %bdown%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Delete k3d cluster\n\n" >&2

  printf "  %bstart%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Start stopped k3d cluster\n\n" >&2

  printf "  %bstop%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Stop running k3d cluster\n\n" >&2

  printf "  %brestart%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Restart k3d cluster\n\n" >&2

  printf "  %bdeps%b <up|down|restart>\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Manage docker compose dependencies\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s k3d deps up\n" "$0" >&2
  printf "  %s k3d up\n" "$0" >&2
  printf "  %s k3d stop && %s k3d start\n\n" "$0" "$0" >&2

  exit "${1:-0}"
}

usage_deps() {
  printf "%bUsage:%b %s deps <subcommand>\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage docker compose dependencies.\n\n" >&2

  printf "%bSubcommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bup%b         Start docker compose dependencies\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bdown%b       Stop docker compose dependencies\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %brestart%b    Restart docker compose dependencies\n\n" "${GREEN}" "${NORMAL}" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s deps up\n" "$0" >&2
  printf "  %s deps down\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_setup() {
  printf "%bUsage:%b %s setup\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Install addons (MetalLB, cert-manager) and apply k3s core manifests.\n" >&2
  printf "Prompts for confirmation with current kubectl context.\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s setup\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_sst_apply() {
  printf "%bUsage:%b %s sst-apply <FILE|all> [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Render SST templates (envsubst) and apply to cluster.\n\n" >&2

  printf "%bArguments:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b<FILE>%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Template file with \${VAR} placeholders\n\n" >&2
  printf "  %ball%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Apply all templates (helm-charts, monitoring, apps)\n\n" >&2

  printf "%bOptions:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b--kubeconfig%b <PATH>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Kubeconfig file for kubectl operations\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s sst-apply all\n" "$0" >&2
  printf "  %s sst-apply k3s/apps/templates.yaml\n" "$0" >&2
  printf "  %s sst-apply all --kubeconfig ./k3s.yaml\n\n" "$0" >&2

  exit "${1:-0}"
}
