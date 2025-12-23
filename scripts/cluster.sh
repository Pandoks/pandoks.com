#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
readonly SCRIPT_DIR

. "${SCRIPT_DIR}/lib/font.sh"
. "${SCRIPT_DIR}/lib/ip.sh"
. "${SCRIPT_DIR}/lib/secrets.sh"
. "${SCRIPT_DIR}/lib/kubernetes.sh"

usage() {
  printf "%bUsage:%b %s <command> [options]\n\n" "${BOLD}" "${NORMAL}" "$0" >&2
  printf "Manage k3d clusters and deploy k3s applications.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bk3d-up%b [--network <NAME>]\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Create local k3d cluster with 3 servers and 3 agents\n" >&2
  printf "      %b--network%b <NAME>  Attach to existing docker network\n\n" "${YELLOW}" "${NORMAL}" >&2

  printf "  %bk3d-down%b\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Delete local k3d cluster\n\n" >&2

  printf "  %bsetup%b [--kubeconfig <PATH>] [--k3d] [--ip-pool <RANGE>] [--network <NAME>]\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Install addons (MetalLB, cert-manager) and apply k3s manifests\n" >&2
  printf "      %b--kubeconfig%b <PATH>  Kubeconfig file for kubectl operations\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      %b--k3d%b                Auto-detect IP pool from k3d network\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      %b--ip-pool%b <RANGE>    Explicit IP pool (10.0.1.0/24 or 10.0.1.100-10.0.1.200)\n" "${YELLOW}" "${NORMAL}" >&2
  printf "      %b--network%b <NAME>     Docker network (default: k3d-local-cluster)\n\n" "${YELLOW}" "${NORMAL}" >&2

  printf "  %bpush-secrets%b [--kubeconfig <PATH>]\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Fetch SST secrets and apply to cluster\n" >&2
  printf "      %b--kubeconfig%b <PATH>  Kubeconfig file for kubectl operations\n\n" "${YELLOW}" "${NORMAL}" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %s k3d-up && %s setup --k3d\n" "$0" "$0" >&2
  printf "  %s setup --ip-pool 10.0.1.100-10.0.1.200\n" "$0" >&2
  printf "  %s push-secrets --kubeconfig ~/.kube/config\n\n" "$0" >&2

  exit 0
}

k3d_up() {
  k3d_up_network_name=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --network)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --network requires a network name\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        k3d_up_network_name="$2"
        shift 2
        ;;
      *)
        printf "%bError:%b Unexpected argument for k3d-up: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        exit 1
        ;;
    esac
  done

  if k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' already exists. Skipping creation."
    return 0
  fi

  echo "Creating k3d cluster 'local-cluster'..."
  if [ -n "${k3d_up_network_name}" ]; then
    if ! docker network inspect "${k3d_up_network_name}" > /dev/null 2>&1; then
      printf "%bError:%b docker network not found: %s\n" "${RED}" "${NORMAL}" "${k3d_up_network_name}" >&2
      return 1
    fi
    k3d_up_network_args="--network ${k3d_up_network_name}"
    echo "Attaching loadbalancer to docker network: ${k3d_up_network_name}"
  fi

  k3d cluster create local-cluster \
    --servers 3 \
    --agents 3 \
    --registry-create local-registry:12345 \
    --api-port 6444 \
    --k3s-arg "--disable=traefik@server:*" \
    --k3s-arg "--disable=servicelb@server:*" \
    -p "8080:30080@loadbalancer" \
    "${k3d_up_network_args}"
  printf "%b✓ k3d cluster created%b\n" "${GREEN}" "${NORMAL}"
}

k3d_down() {
  if [ $# -gt 0 ]; then
    printf "%bError:%b Unexpected argument for k3d-down: %s\n" "${RED}" "${NORMAL}" "$1" >&2
    exit 1
  fi

  if ! k3d cluster list 2> /dev/null | grep -q "^local-cluster"; then
    echo "k3d cluster 'local-cluster' not found. Nothing to delete."
    return 0
  fi

  echo "Deleting k3d cluster 'local-cluster'..."
  k3d cluster delete local-cluster
  printf "%b✓ k3d cluster deleted%b\n" "${GREEN}" "${NORMAL}"
}

push_secrets() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --kubeconfig)
        if [ $# -lt 2 ]; then
          printf "%bError:%b Missing value for --kubeconfig\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        KUBECONFIG="$(validate_and_get_absolute_kubeconfig_path "$2")"
        export KUBECONFIG
        printf "%bUsing kubeconfig:%b %s\n" "${BOLD}" "${NORMAL}" "${KUBECONFIG}" >&2
        shift 2
        ;;
      *)
        printf "%bError:%b Unexpected argument for push-secrets: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        exit 1
        ;;
    esac
  done

  push_secrets_current_kube_context=$(kubectl config current-context)
  printf "%bApplying secrets to Kubernetes cluster: %s%b [y/n] " "${BOLD}" "${push_secrets_current_kube_context}" "${NORMAL}"
  read -r push_secrets_confirm
  if [ "${push_secrets_confirm}" != "y" ]; then
    echo "Skipping secrets push"
    return 0
  fi

  push_secrets_secrets_yaml_template="${REPO_ROOT}/k3s/apps/secrets.yaml"
  if [ ! -f "${push_secrets_secrets_yaml_template}" ]; then
    printf "%bError:%b Missing secrets.yaml template: %s\n" "${RED}" "${NORMAL}" "${push_secrets_secrets_yaml_template}" >&2
    return 1
  fi

  echo "Fetching SST secrets..."
  push_secrets_secrets_json=$(get_sst_secrets)
  if [ -z "${push_secrets_secrets_json}" ]; then
    printf "%bError:%b Failed to fetch SST secrets. Make sure you're authenticated with SST.\n" "${RED}" "${NORMAL}" >&2
    printf "Try running: %bpnpm run sso%b.\n" "${BOLD}" "${NORMAL}" >&2
    return 1
  fi
  echo "SST secrets fetched"

  echo "Generating secrets.yaml..."
  while IFS= read -r push_secrets_entry; do
    push_secrets_secret_key="$(printf "%s" "${push_secrets_entry}" | jq -r '.key')"
    push_secrets_secret_value="$(printf "%s" "${push_secrets_entry}" | jq -r '.value')"

    if [ "$(printf "%s" "${push_secrets_secret_value}" | wc -l)" -gt 1 ]; then
      push_secrets_indent="$(grep "\${${push_secrets_secret_key}}" "${push_secrets_secrets_yaml_template}" \
        | sed 's/\${.*//')"
      push_secrets_secret_value="$(printf "%s" "${push_secrets_secret_value}" \
        | sed "2,\$ s/^/${push_secrets_indent}/")"
    fi

    export "${push_secrets_secret_key}"="${push_secrets_secret_value}"
  done << EOF
$(printf "%s" "${push_secrets_secrets_json}" | jq -c 'to_entries[]')
EOF

  push_secrets_tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${push_secrets_tmp_dir}"' EXIT
  envsubst < "${REPO_ROOT}/k3s/apps/secrets.yaml" > "${push_secrets_tmp_dir}/secrets.yaml"
  echo "Generated secrets.yaml at ${push_secrets_tmp_dir}/secrets.yaml"

  echo "Pushing secrets to Kubernetes cluster..."
  kubectl apply -f "${push_secrets_tmp_dir}/secrets.yaml"
  printf "%b✓ secrets pushed to Kubernetes cluster%b\n" "${GREEN}" "${NORMAL}"
}

setup_cluster() {
  setup_cluster_k3s_dir="${REPO_ROOT}/k3s"
  setup_cluster_network_name=""
  setup_cluster_k3d_flag="false"
  setup_cluster_ip_pool_range=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --kubeconfig)
        if [ $# -lt 2 ]; then
          printf "%bError:%b Missing value for --kubeconfig\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        KUBECONFIG="$(validate_and_get_absolute_kubeconfig_path "$2")"
        export KUBECONFIG
        printf "%bUsing kubeconfig:%b %s\n" "${BOLD}" "${NORMAL}" "${KUBECONFIG}" >&2
        shift 2
        ;;
      --k3d)
        setup_cluster_k3d_flag="true"
        shift
        ;;
      --ip-pool)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --ip-pool requires a range (e.g., 10.0.1.100-10.0.1.200 or 10.0.1.0/24)\n" \
            "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        setup_cluster_ip_pool_range="$2"
        shift 2
        ;;
      --network)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --network requires a network name\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        setup_cluster_network_name="$2"
        shift 2
        ;;
      *)
        printf "%bError:%b Unexpected argument for setup: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        exit 1
        ;;
    esac
  done

  if [ "${setup_cluster_k3d_flag}" = "true" ]; then
    setup_cluster_ip_pool_range=$(get_k3d_ip_pool "${setup_cluster_network_name}")
  elif [ -n "${IP_POOL_RANGE:-}" ]; then
    setup_cluster_ip_pool_range="${IP_POOL_RANGE}"
  elif [ -z "${setup_cluster_ip_pool_range}" ]; then
    printf "%bError:%b No IP pool specified. Provide an IP pool via --ip-pool or use --k3d to auto-detect.\n" "${RED}" "${NORMAL}" >&2
  fi

  if ! validate_ip_pool_range "${setup_cluster_ip_pool_range}"; then
    echo "Invalid IP pool range: ${setup_cluster_ip_pool_range}" >&2
    echo "Acceptable formats: A.B.C.D/NN or A.B.C.D-E.F.G.H" >&2
    exit 1
  fi
  export IP_POOL_RANGE="${setup_cluster_ip_pool_range}"

      kubectl -n metallb-system rollout status deploy/metallb-controller --timeout=300s

      echo "Applying core kustomization with IP pool range: ${ip_pool_range}"
      export IP_POOL_RANGE="${ip_pool_range}"
      kubectl kustomize "${k3s_dir}/core" --load-restrictor LoadRestrictionsNone \
        | envsubst \
        | kubectl apply -f -

      echo "Setup complete."
      ;;

    k3d-down) k3d_down ;;

main() {
  [ $# -ge 1 ] || usage
  cmd="$1"
  shift

  case "${cmd}" in
    k3d-up) k3d_up "$@" ;;
    setup) setup_cluster "$@" ;;
    k3d-down) k3d_down "$@" ;;
    push-secrets) push_secrets "$@" ;;
    *)
      printf "%bError:%b Unknown command '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage
      ;;
  esac
}

main "$@"
