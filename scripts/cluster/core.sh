# shellcheck shell=sh

cmd_core() {
  while [ $# -gt 0 ]; do
    case "$1" in
      help | --help | -h) usage_core ;;
      *)
        printf "%bError:%b Unexpected argument for core: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_core 1
        ;;
    esac
  done

  # Skip confirmation if called from sync
  if [ "${cmd_core_no_confirm:-}" != "true" ]; then
    cmd_core_current_context=$(kubectl config current-context)
    printf "%bApply core to cluster: %s%b [y/n] " "${BOLD}" "${cmd_core_current_context}" "${NORMAL}"
    read -r cmd_core_confirm
    if [ "${cmd_core_confirm}" != "y" ]; then
      echo "Skipping core"
      return 0
    fi
  fi

  echo "Installing Helm-based addons (MetalLB, cert-manager, etc.)..."
  kubectl apply --server-side -k "${REPO_ROOT}/k3s/base/helm-charts"

  echo "Waiting for cert-manager CRDs to be established..."
  for cmd_core_crd in \
    certificates.cert-manager.io \
    issuers.cert-manager.io \
    clusterissuers.cert-manager.io; do
    wait_for_crd "${cmd_core_crd}" 180
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

  echo "Applying core kustomization..."
  kubectl apply --server-side -k "${REPO_ROOT}/k3s/base/core"

  echo "Waiting for Plans CRD to be established..."
  wait_for_crd "plans.upgrade.cattle.io" 120
  printf "%b✓ Plans CRD established%b\n" "${GREEN}" "${NORMAL}"

  printf "%b✓ Core complete%b\n" "${GREEN}" "${NORMAL}"
}
