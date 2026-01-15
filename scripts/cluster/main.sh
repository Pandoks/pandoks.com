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

cmd_sst_apply() {
  [ $# -ge 1 ] || usage_sst_apply 1
  case "$1" in
    help | --help | -h) usage_sst_apply ;;
  esac
  cmd_sst_apply_template="$1"
  shift

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
      help | --help | -h) usage_sst_apply ;;
      *)
        printf "%bError:%b Unexpected argument for sst-apply: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_sst_apply 1
        ;;
    esac
  done

  cmd_sst_apply_current_kube_context=$(kubectl config current-context)
  printf "%bApplying SST templates to Kubernetes cluster: %s%b [y/n] " "${BOLD}" "${cmd_sst_apply_current_kube_context}" "${NORMAL}"
  read -r cmd_sst_apply_confirm
  if [ "${cmd_sst_apply_confirm}" != "y" ]; then
    echo "Skipping sst-apply"
    return 0
  fi

  if [ ! -f "${cmd_sst_apply_template}" ]; then
    printf "%bError:%b Missing template file: %s\n" "${RED}" "${NORMAL}" "${cmd_sst_apply_template}" >&2
    return 1
  fi

  echo "Fetching SST secrets..."
  cmd_sst_apply_secrets_json=$(get_sst_secrets)
  if [ -z "${cmd_sst_apply_secrets_json}" ]; then
    printf "%bError:%b Failed to fetch SST secrets. Make sure you're authenticated with SST.\n" "${RED}" "${NORMAL}" >&2
    printf "Try running: %bpnpm run sso%b.\n" "${BOLD}" "${NORMAL}" >&2
    return 1
  fi
  echo "SST secrets fetched"

  echo "Rendering template..."
  while IFS= read -r cmd_sst_apply_entry; do
    cmd_sst_apply_key="$(printf "%s" "${cmd_sst_apply_entry}" | jq -r '.key')"
    cmd_sst_apply_value="$(printf "%s" "${cmd_sst_apply_entry}" | jq -r '.value')"

    if [ "$(printf "%s" "${cmd_sst_apply_value}" | wc -l)" -gt 1 ]; then
      cmd_sst_apply_indent="$(grep "\${${cmd_sst_apply_key}}" "${cmd_sst_apply_template}" \
        | sed 's/\${.*//')"
      cmd_sst_apply_value="$(printf "%s" "${cmd_sst_apply_value}" \
        | sed "2,\$ s/^/${cmd_sst_apply_indent}/")"
    fi

    export "${cmd_sst_apply_key}"="${cmd_sst_apply_value}"
  done << EOF
$(printf "%s" "${cmd_sst_apply_secrets_json}" | jq -c 'to_entries[]')
EOF

  cmd_sst_apply_tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_sst_apply_tmp_dir}"' EXIT
  envsubst < "${cmd_sst_apply_template}" > "${cmd_sst_apply_tmp_dir}/rendered.yaml"
  echo "Rendered template at ${cmd_sst_apply_tmp_dir}/rendered.yaml"

  echo "Applying to Kubernetes cluster..."
  kubectl apply --server-side -f "${cmd_sst_apply_tmp_dir}/rendered.yaml"
  printf "%b✓ SST templates applied to Kubernetes cluster%b\n" "${GREEN}" "${NORMAL}"
}

cmd_setup() {
  cmd_setup_network_name=""
  cmd_setup_k3d_flag="false"
  cmd_setup_ip_pool_range=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --kubeconfig)
        if [ $# -lt 2 ]; then
          printf "%bError:%b Missing value for --kubeconfig\n" "${RED}" "${NORMAL}" >&2
          usage_setup 1
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
          usage_setup 1
        fi
        cmd_setup_ip_pool_range="$2"
        shift 2
        ;;
      --network)
        if [ $# -lt 2 ]; then
          printf "%bError:%b --network requires a network name\n" "${RED}" "${NORMAL}" >&2
          usage_setup 1
        fi
        cmd_setup_network_name="$2"
        shift 2
        ;;
      help | --help | -h) usage_setup ;;
      *)
        printf "%bError:%b Unexpected argument for setup: %s\n" "${RED}" "${NORMAL}" "$1" >&2
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
    setup) cmd_setup "$@" ;;
    sst-apply) cmd_sst_apply "$@" ;;
    help | --help | -h) usage ;;
    *)
      printf "%bError:%b Unknown command '%s'\n" "${RED}" "${NORMAL}" "${cmd}" >&2
      usage 1
      ;;
  esac
}

main "$@"
