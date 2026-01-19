# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s <command> [subcommand] [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage k3d clusters and deploy k3s applications.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bk3d%b             Manage local k3d cluster and dependencies\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Subcommands: up, down, start, stop, restart, deps\n\n" >&2

  printf "  %bdeploy%b          Deploy environment overlay to cluster\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Usage: deploy <dev|prod> [--bootstrap] [--stage <STAGE>] [--dry-run]\n\n" >&2

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

usage_deploy() {
  printf "%bUsage:%b %s deploy <dev|prod> [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Deploy environment overlay to cluster.\n\n" >&2
  printf "This command:\n" >&2
  printf "  1. Runs kubectl kustomize on the specified target\n" >&2
  printf "  2. Substitutes SST secrets and computed variables\n" >&2
  printf "  3. Applies to the cluster with server-side apply\n" >&2
  printf "  4. Waits for CRDs to be established (bootstrap only)\n\n" >&2

  printf "%bEnvironments:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bdev%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Deploy dev overlay with:\n" >&2
  printf "        - ImageRegistry: local-registry:5000\n" >&2
  printf "        - ImageTag: latest\n" >&2
  printf "        - IsDev: true\n\n" >&2
  printf "  %bprod%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Deploy prod overlay with:\n" >&2
  printf "        - ImageRegistry: ghcr.io/pandoks\n" >&2
  printf "        - ImageTag: <branch-name> (or 'latest' on main)\n" >&2
  printf "        - IsDev: false\n\n" >&2

  printf "%bOptions:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b--bootstrap%b\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Install only helm-charts (CRD providers) and wait for CRDs.\n" >&2
  printf "      Run this first on a fresh cluster before running deploy.\n\n" >&2
  printf "  %b--stage%b <STAGE>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      SST stage to fetch secrets from (default: SST's default stage)\n\n" >&2
  printf "  %b--dry-run%b\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Show rendered YAML without applying to cluster\n\n" >&2
  printf "  %b--kubeconfig%b <PATH>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Kubeconfig file for kubectl operations\n\n" >&2

  printf "%bTemplate Variables:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  \${ImageRegistry}    - Container registry (local or GHCR)\n" >&2
  printf "  \${ImageTag}         - Image tag (latest or branch name)\n" >&2
  printf "  \${IsDev}            - 'true' or 'false' for conditional logic\n" >&2
  printf "  \${BackupBucket}     - S3 bucket for backups from SST\n" >&2
  printf "  \${<SSTSecret>}      - Any SST secret by name\n" >&2
  printf "  \${<Secret> | base64} - Base64 encode a secret value\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  # First-time cluster setup:\n" >&2
  printf "  %s deploy dev --bootstrap\n" "$0" >&2
  printf "  %s deploy dev\n\n" "$0" >&2
  printf "  # Regular deployments:\n" >&2
  printf "  %s deploy dev\n" "$0" >&2
  printf "  %s deploy dev --dry-run\n" "$0" >&2
  printf "  %s deploy prod --stage production\n" "$0" >&2
  printf "  %s deploy prod --kubeconfig ~/.kube/prod-config\n\n" "$0" >&2

  exit "${1:-0}"
}
