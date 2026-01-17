# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s <command> [subcommand] [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage k3d clusters and deploy k3s applications.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bk3d%b             Manage local k3d cluster and dependencies\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Subcommands: up, down, start, stop, restart, deps\n\n" >&2

  printf "  %bcore%b            Apply core infrastructure (helm charts + CRDs)\n" "${GREEN}" "${NORMAL}" >&2
  printf "      (idempotent, safe to run multiple times)\n\n" >&2

  printf "  %bdeploy%b          Deploy environment overlay (dev or prod)\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Usage: deploy <dev|prod>\n\n" >&2

  printf "  %bsync%b            Run core + deploy together\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Usage: sync <dev|prod>\n\n" >&2

  printf "  %bsst-apply%b       Render SST templates and apply to cluster\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Usage: sst-apply <FILE|all> [--stage <STAGE>] [--kubeconfig <PATH>]\n\n" >&2

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

usage_core() {
  printf "%bUsage:%b %s core\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Apply core infrastructure (helm charts, CRDs, base resources).\n" >&2
  printf "Idempotent - safe to run multiple times.\n\n" >&2

  printf "%bWhat it does:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  1. Install helm charts (MetalLB, cert-manager, HAProxy, Prometheus)\n" >&2
  printf "  2. Wait for CRDs to be established\n" >&2
  printf "  3. Apply core resources (IPAddressPool, ClusterIssuers, namespaces)\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s core\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_deploy() {
  printf "%bUsage:%b %s deploy <dev|prod>\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Deploy environment-specific overlay to cluster.\n\n" >&2

  printf "%bEnvironments:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bdev%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Apply dev overlay (MetalLB IP patch for docker network)\n\n" >&2
  printf "  %bprod%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Apply prod overlay (tailscale, system-upgrade controller + plans)\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s deploy dev\n" "$0" >&2
  printf "  %s deploy prod\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_sync() {
  printf "%bUsage:%b %s sync <dev|prod>\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Run core + deploy together. Ideal for CI/CD.\n\n" >&2

  printf "%bEnvironments:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bdev%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Apply core infrastructure + dev overlay\n\n" >&2
  printf "  %bprod%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Apply core infrastructure + prod overlay\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s sync dev\n" "$0" >&2
  printf "  %s sync prod\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_sst_apply() {
  printf "%bUsage:%b %s sst-apply <FILE|all> [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Render SST templates and apply to cluster.\n\n" >&2

  printf "%bArguments:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b<FILE>%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Template file with \${VAR} or \${VAR | filter} placeholders\n\n" >&2
  printf "  %ball%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Apply all templates (monitoring, apps, tailscale)\n\n" >&2

  printf "%bOptions:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b--stage%b <STAGE>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      SST stage to fetch secrets from (default: current user stage)\n\n" >&2
  printf "  %b--dry-run%b\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Show rendered YAML without applying to cluster\n\n" >&2
  printf "  %b--kubeconfig%b <PATH>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Kubeconfig file for kubectl operations\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s sst-apply all\n" "$0" >&2
  printf "  %s sst-apply all --stage dev\n" "$0" >&2
  printf "  %s sst-apply all --stage production\n" "$0" >&2
  printf "  %s sst-apply all --dry-run\n" "$0" >&2
  printf "  %s sst-apply k3s/templates/apps.yaml --dry-run\n\n" "$0" >&2

  exit "${1:-0}"
}
