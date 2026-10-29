# shellcheck shell=sh

usage() {
  printf "%bUsage:%b %s <command> [subcommand] [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage k3d clusters and deploy k3s applications.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bk3d%b             Manage local k3d cluster and dependencies\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Subcommands: up, down, start, stop, restart, deps\n\n" >&2

  printf "  %bdeploy%b          Deploy environment overlay to cluster\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Usage: deploy <local|dev|prod> [--bootstrap] [--stage <STAGE>] [--dry-run]\n\n" >&2

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
  printf "  %s k3d deps up\n" "$0" >&2
  printf "  %s k3d deps down\n\n" "$0" >&2

  exit "${1:-0}"
}

usage_deploy() {
  printf "%bUsage:%b %s deploy <local|dev|prod> [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Render Kustomize, substitute SST values, and apply to the selected kubectl context.\n\n" >&2

  printf "%bEnvironments:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %blocal%b      Local registry images/charts; SST's default stage\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bdev%b        Dev cluster; declared image pins; SST's default stage\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %bprod%b       Production cluster; declared image pins; SST stage production\n\n" "${GREEN}" "${NORMAL}" >&2
  printf "Argo deploys successful main builds to production.\n" >&2
  printf "Use this command for bootstrap, local work, and manual recovery.\n\n" >&2

  printf "%bOptions:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %b--bootstrap%b\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Apply k3s/bootstrap/<env>; wait for Established CRDs and rollouts.\n" >&2
  printf "      Run once on a fresh cluster, then apply the full overlay.\n\n" >&2
  printf "  %b--stage%b <STAGE>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      SST stage (local/dev: SST default; prod: forced production).\n\n" >&2
  printf "  %b--dry-run%b\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Render YAML; skip confirmation, apply, and waits.\n\n" >&2
  printf "  %b--kubeconfig%b <PATH>\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      Kubeconfig for kubectl operations.\n\n" >&2
  printf "  %b--quiet%b, %b-q%b\n" "${YELLOW}" "${NORMAL}" "${YELLOW}" "${NORMAL}" >&2
  printf "      Hide info logs and the dry-run heading. Prompts and errors remain visible.\n\n" >&2

  printf "Renders need SST and standalone Kustomize; pinned remote resources need network access.\n" >&2
  printf "Image versions come from manifests; deploy does not build or query a registry.\n\n" >&2

  printf "%bTemplate Variables:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  \${<SST Resource>}    Exported SST value by resource name\n" >&2
  printf "  \${<Secret> | quote}  Quote a secret for YAML\n" >&2
  printf "  \${<Secret> | base64} Base64 encode a secret\n" >&2
  printf "Missing or empty referenced SST values stop rendering.\n\n" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s deploy local --bootstrap\n" "$0" >&2
  printf "  %s deploy local\n" "$0" >&2
  printf "  %s deploy dev --bootstrap\n" "$0" >&2
  printf "  %s deploy dev\n" "$0" >&2
  printf "  %s deploy prod --kubeconfig ~/.kube/prod-config\n" "$0" >&2
  printf "  %s deploy dev --dry-run --quiet > rendered.yaml\n\n" "$0" >&2

  exit "${1:-0}"
}
