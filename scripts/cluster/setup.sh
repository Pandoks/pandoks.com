# shellcheck shell=sh

cmd_setup() {
  while [ $# -gt 0 ]; do
    case "$1" in
      help | --help | -h) usage_setup ;;
      *)
        printf "%bError:%b Unexpected argument for setup: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_setup 1
        ;;
    esac
  done

  cmd_setup_current_context=$(kubectl config current-context)
  printf "%bSetup cluster: %s%b [y/n] " "${BOLD}" "${cmd_setup_current_context}" "${NORMAL}"
  read -r cmd_setup_confirm
  if [ "${cmd_setup_confirm}" != "y" ]; then
    echo "Skipping setup"
    return 0
  fi

  echo "Installing Helm-based addons (MetalLB, cert-manager, etc.)..."
  kubectl apply --server-side -k "${REPO_ROOT}/k3s/base/helm-charts"

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

  echo "Applying core kustomization..."
  kubectl apply --server-side -k "${REPO_ROOT}/k3s/base/core"

  echo "Waiting for Plans CRD to be established..."
  wait_for_crd "plans.upgrade.cattle.io" 120
  printf "%b✓ Plans CRD established%b\n" "${GREEN}" "${NORMAL}"

  printf "%b✓ Setup complete%b\n" "${GREEN}" "${NORMAL}"
}
