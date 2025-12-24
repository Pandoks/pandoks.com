# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s <command> [subcommand] [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage k3d clusters and deploy k3s applications.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bk3d%b             Manage local k3d cluster and dependencies\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Subcommands: up [--network <NAME>], down, start, stop, restart, deps\n\n" >&2

  printf "  %bsetup%b         Setup cluster with addons and manifests\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Options: --kubeconfig <PATH>, --k3d, --ip-pool <RANGE>, --network <NAME>\n\n" >&2

  printf "  %bpush-secrets%b   Push SST secrets to cluster\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Options: --kubeconfig <PATH>\n\n" >&2

  printf "Run '%s <command> --help' for more information on a command.\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_k3d() {
  printf "%bUsage:%b %s k3d <subcommand> [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage local k3d cluster and dependencies.\n\n" >&2

  printf "%bSubcommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bup%b [--network <NAME>]\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Create k3d cluster with 3 servers and 3 agents\n" >&2
  printf "      %b--network%b <NAME>  Attach to existing docker network\n\n" "${YELLOW}" "${NORMAL}" >&2

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
  printf "  %s k3d up\n" "$0" >&2
  printf "  %s k3d up --network pandoks-net\n" "$0" >&2
  printf "  %s k3d deps up\n" "$0" >&2
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
  printf "%bUsage:%b %s setup [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Install addons (MetalLB, cert-manager) and apply k3s manifests.\n\n" >&2

  printf "%bOptions:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b--kubeconfig%b <PATH>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Kubeconfig file for kubectl operations\n\n" >&2

  printf "  %b--k3d%b\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Auto-detect IP pool from k3d network\n\n" >&2

  printf "  %b--ip-pool%b <RANGE>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Explicit IP pool (10.0.1.0/24 or 10.0.1.100-10.0.1.200)\n\n" >&2

  printf "  %b--network%b <NAME>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Docker network (default: k3d-local-cluster)\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s setup --k3d\n" "$0" >&2
  printf "  %s setup --ip-pool 10.0.1.100-10.0.1.200\n" "$0" >&2
  printf "  %s setup --kubeconfig ./k3s.yaml --ip-pool 10.0.1.0/24\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_push_secrets() {
  printf "%bUsage:%b %s push-secrets [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Fetch SST secrets and apply to cluster.\n\n" >&2

  printf "%bOptions:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b--kubeconfig%b <PATH>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Kubeconfig file for kubectl operations\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s push-secrets\n" "$0" >&2
  printf "  %s push-secrets --kubeconfig ~/.kube/config\n\n" "$0" >&2

  exit "${1:-0}"
}
