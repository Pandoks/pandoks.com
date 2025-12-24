#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/ip.sh"
. "${REPO_ROOT}/scripts/lib/secrets.sh"
. "${REPO_ROOT}/scripts/lib/kubernetes.sh"
. "${SCRIPT_DIR}/usage.sh"
. "${SCRIPT_DIR}/k3d.sh"
. "${SCRIPT_DIR}/deps.sh"

cmd_push_secrets() {
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
      help | --help | -h) usage_push_secrets ;;
      *)
        printf "%bError:%b Unexpected argument for push-secrets: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_push_secrets 1
        ;;
    esac
  done

  cmd_push_secrets_current_kube_context=$(kubectl config current-context)
  printf "%bApplying secrets to Kubernetes cluster: %s%b [y/n] " "${BOLD}" "${cmd_push_secrets_current_kube_context}" "${NORMAL}"
  read -r cmd_push_secrets_confirm
  if [ "${cmd_push_secrets_confirm}" != "y" ]; then
    echo "Skipping secrets push"
    return 0
  fi

  cmd_push_secrets_secrets_yaml_template="${REPO_ROOT}/k3s/apps/secrets.yaml"
  if [ ! -f "${cmd_push_secrets_secrets_yaml_template}" ]; then
    printf "%bError:%b Missing secrets.yaml template: %s\n" "${RED}" "${NORMAL}" "${cmd_push_secrets_secrets_yaml_template}" >&2
    return 1
  fi

  echo "Fetching SST secrets..."
  cmd_push_secrets_secrets_json=$(get_sst_secrets)
  if [ -z "${cmd_push_secrets_secrets_json}" ]; then
    printf "%bError:%b Failed to fetch SST secrets. Make sure you're authenticated with SST.\n" "${RED}" "${NORMAL}" >&2
    printf "Try running: %bpnpm run sso%b.\n" "${BOLD}" "${NORMAL}" >&2
    return 1
  fi
  echo "SST secrets fetched"

  echo "Generating secrets.yaml..."
  while IFS= read -r cmd_push_secrets_entry; do
    cmd_push_secrets_secret_key="$(printf "%s" "${cmd_push_secrets_entry}" | jq -r '.key')"
    cmd_push_secrets_secret_value="$(printf "%s" "${cmd_push_secrets_entry}" | jq -r '.value')"

    if [ "$(printf "%s" "${cmd_push_secrets_secret_value}" | wc -l)" -gt 1 ]; then
      cmd_push_secrets_indent="$(grep "\${${cmd_push_secrets_secret_key}}" "${cmd_push_secrets_secrets_yaml_template}" \
        | sed 's/\${.*//')"
      cmd_push_secrets_secret_value="$(printf "%s" "${cmd_push_secrets_secret_value}" \
        | sed "2,\$ s/^/${cmd_push_secrets_indent}/")"
    fi

    export "${cmd_push_secrets_secret_key}"="${cmd_push_secrets_secret_value}"
  done << EOF
$(printf "%s" "${cmd_push_secrets_secrets_json}" | jq -c 'to_entries[]')
EOF

  cmd_push_secrets_tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_push_secrets_tmp_dir}"' EXIT
  envsubst < "${REPO_ROOT}/k3s/apps/secrets.yaml" > "${cmd_push_secrets_tmp_dir}/secrets.yaml"
  echo "Generated secrets.yaml at ${cmd_push_secrets_tmp_dir}/secrets.yaml"

  echo "Pushing secrets to Kubernetes cluster..."
  kubectl apply --server-side -f "${cmd_push_secrets_tmp_dir}/secrets.yaml"
  printf "%b✓ secrets pushed to Kubernetes cluster%b\n" "${GREEN}" "${NORMAL}"
}

cmd_setup_cluster() {
  cmd_setup_network_name=""
  cmd_setup_k3d_flag="false"
  cmd_setup_ip_pool_range=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --kubeconfig)
        if [ $# -lt 2 ]; then
          printf "%bError:%b Missing value for --kubeconfig\n" "${RED}" "${NORMAL}" >&2
          usage_setup_cluster 1
        fi
        KUBECONFIG="$(validate_and_get_absolute_kubeconfig_path "$2")"
        export KUBECONFIG
        printf "%bUsing kubeconfig:%b %s\n" "${BOLD}" "${NORMAL}" "${KUBECONFIG}" >&2
        shift 2
        ;;
      --k3d)
        cmd_setup_k3d_flag="true"
        shift
        ;;
      --ip-pool)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --ip-pool requires a range (e.g., 10.0.1.100-10.0.1.200 or 10.0.1.0/24)\n" \
            "${RED}" "${NORMAL}" >&2
          usage_setup_cluster 1
        fi
        cmd_setup_ip_pool_range="$2"
        shift 2
        ;;
      --network)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --network requires a network name\n" "${RED}" "${NORMAL}" >&2
          usage_setup_cluster 1
        fi
        cmd_setup_network_name="$2"
        shift 2
        ;;
      help | --help | -h) usage_setup_cluster ;;
      *)
        printf "%bError:%b Unexpected argument for setup-cluster: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_setup_cluster 1
        ;;
    esac
  done

  if [ "${cmd_setup_k3d_flag}" = "true" ]; then
    cmd_setup_ip_pool_range=$(get_k3d_ip_pool "${cmd_setup_network_name}")
  elif [ -n "${IP_POOL_RANGE:-}" ]; then
    cmd_setup_ip_pool_range="${IP_POOL_RANGE}"
  elif [ -z "${cmd_setup_ip_pool_range}" ]; then
    printf "%bError:%b No IP pool specified. Provide an IP pool via --ip-pool or use --k3d to auto-detect.\n" "${RED}" "${NORMAL}" >&2
    usage_setup_cluster 1
  fi

  if ! is_valid_ip_pool_range "${cmd_setup_ip_pool_range}"; then
    echo "Invalid IP pool range: ${cmd_setup_ip_pool_range}" >&2
    echo "Acceptable formats: A.B.C.D/NN or A.B.C.D-E.F.G.H" >&2
    usage_setup_cluster 1
  fi
  export IP_POOL_RANGE="${cmd_setup_ip_pool_range}"

  echo "Installing Helm-based addons (MetalLB, ingress, etc.)..."
  kubectl apply --server-side -k "${REPO_ROOT}/k3s/helm-charts"

  echo "Waiting for cert-manager CRDs to be established..."
  for cmd_setup_crd in \
    certificates.cert-manager.io \
    issuers.cert-manager.io \
    clusterissuers.cert-manager.io; do
    wait_for_crd "${cmd_setup_crd}" 180
  done
  printf "%b✓ cert-manager CRDs established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for cert-manager deployments to roll out..."
  kubectl -n cert-manager rollout status deploy/cert-manager --timeout=300s || true
  kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=300s || true
  kubectl -n cert-manager rollout status deploy/cert-manager-cainjector --timeout=300s || true
  printf "%b✓ cert-manager deployments established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for MetalLB CRDs to be established..."
  wait_for_crd "ipaddresspools.metallb.io" 120
  wait_for_crd "l2advertisements.metallb.io" 120
  kubectl -n metallb-system rollout status deploy/metallb-controller --timeout=300s
  printf "%b✓ MetalLB CRDs established%b\n" "${GREEN}" "${NORMAL}"

  echo "Applying core kustomization with IP pool range: ${cmd_setup_ip_pool_range}"
  kubectl kustomize "${REPO_ROOT}/k3s/core" --load-restrictor LoadRestrictionsNone \
    | envsubst \
    | kubectl apply --server-side -f -

  printf "%b✓ Setup complete%b\n" "${GREEN}" "${NORMAL}"
}

main() {
  [ $# -ge 1 ] || usage 1
  cmd="$1"
  shift

  case "${cmd}" in
    k3d) cmd_k3d "$@" ;;
    deps) cmd_deps "$@" ;;
    setup-cluster) cmd_setup_cluster "$@" ;;
    push-secrets) cmd_push_secrets "$@" ;;
    help | --help | -h) usage ;;
    *)
      printf "%bError:%b Unknown command '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage 1
      ;;
  esac
}

main "$@"
