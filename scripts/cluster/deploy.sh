# shellcheck shell=sh

cmd_deploy_compute_vars() {
  cmd_deploy_compute_vars_env="$1"

  case "${cmd_deploy_compute_vars_env}" in
    dev)
      cmd_deploy_compute_vars_is_dev="true"
      cmd_deploy_compute_vars_image_registry="local-registry:5000"
      cmd_deploy_compute_vars_image_tag="latest"
      ;;
    prod)
      cmd_deploy_compute_vars_is_dev="false"
      cmd_deploy_compute_vars_image_registry="ghcr.io/pandoks"
      cmd_deploy_compute_vars_branch=$(git rev-parse --abbrev-ref HEAD 2> /dev/null || echo "main")
      case "${cmd_deploy_compute_vars_branch}" in
        main | master) cmd_deploy_compute_vars_image_tag="latest" ;;
        *) cmd_deploy_compute_vars_image_tag="${cmd_deploy_compute_vars_branch}" ;;
      esac
      ;;
  esac

  jq -n \
    --arg IsDev "${cmd_deploy_compute_vars_is_dev}" \
    --arg ImageRegistry "${cmd_deploy_compute_vars_image_registry}" \
    --arg ImageTag "${cmd_deploy_compute_vars_image_tag}" \
    '{
      IsDev: $IsDev,
      ImageRegistry: $ImageRegistry,
      ImageTag: $ImageTag
    }'
}

cmd_deploy_get_template_vars() {
  cmd_deploy_get_template_vars_env="$1"       # dev|prod
  cmd_deploy_get_template_vars_stage="${2:-}" # --stage <stage> equivalent

  if [ -n "${cmd_deploy_get_template_vars_stage}" ]; then
    printf "Fetching SST resources for stage '%s'...\n" "${cmd_deploy_get_template_vars_stage}" >&2
  else
    printf "Fetching SST resources...\n" >&2
  fi
  cmd_deploy_get_template_vars_sst=$(get_sst_resources "${cmd_deploy_get_template_vars_stage}")
  if [ -z "${cmd_deploy_get_template_vars_sst}" ]; then
    printf "%bError:%b Failed to fetch SST resources. Make sure you're authenticated with SST.\n" "${RED}" "${NORMAL}" >&2
    printf "Try running: %bpnpm run sso%b.\n" "${BOLD}" "${NORMAL}" >&2
    return 1
  fi
  printf "SST resources fetched\n" >&2

  cmd_deploy_get_template_vars_computed=$(cmd_deploy_compute_vars "${cmd_deploy_get_template_vars_env}")

  printf '%s' "${cmd_deploy_get_template_vars_sst}" \
    | jq --argjson computed "${cmd_deploy_get_template_vars_computed}" '. + $computed'
}

cmd_deploy_render_templated_yaml() {
  cmd_deploy_render_kustomize_path="$1"
  cmd_deploy_render_template_vars="$2"
  cmd_deploy_render_is_bootstrap="$3" # true|false

  if [ "${cmd_deploy_render_is_bootstrap}" = "true" ]; then
    printf "Running kustomize on helm-charts...\n" >&2
  else
    printf "Running kustomize on overlay...\n" >&2
  fi
  cmd_deploy_render_kustomize=$(kubectl kustomize "${cmd_deploy_render_kustomize_path}" --load-restrictor LoadRestrictionsNone)

  printf "Substituting template variables...\n" >&2
  template_substitute "${cmd_deploy_render_kustomize}" "${cmd_deploy_render_template_vars}"
}

cmd_deploy_wait_for_crds() {
  printf "Waiting for CRDs to be established...\n"

  echo "Waiting for cert-manager CRDs..."
  for cmd_deploy_wait_for_crds_crd in \
    certificates.cert-manager.io \
    issuers.cert-manager.io \
    clusterissuers.cert-manager.io; do
    wait_for_crd "${cmd_deploy_wait_for_crds_crd}" 180
  done
  printf "%b  cert-manager CRDs established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for cert-manager deployments..."
  kubectl -n cert-manager rollout status deploy/cert-manager --timeout=300s || true
  kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=300s || true
  kubectl -n cert-manager rollout status deploy/cert-manager-cainjector --timeout=300s || true
  printf "%b  cert-manager deployments established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for MetalLB CRDs..."
  wait_for_crd "ipaddresspools.metallb.io" 120
  wait_for_crd "l2advertisements.metallb.io" 120
  kubectl -n metallb-system rollout status deploy/metallb-controller --timeout=300s || true
  printf "%b  MetalLB CRDs established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for Prometheus Operator CRDs..."
  wait_for_crd "servicemonitors.monitoring.coreos.com" 180
  printf "%b  Prometheus Operator CRDs established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for system-upgrade-controller CRDs..."
  wait_for_crd "plans.upgrade.cattle.io" 120
  printf "%b  system-upgrade-controller CRDs established%b\n" "${GREEN}" "${NORMAL}"
}

cmd_deploy() {
  [ $# -ge 1 ] || usage_deploy 1
  cmd_deploy_env="$1"
  shift

  case "${cmd_deploy_env}" in
    dev | prod) ;;
    help | --help | -h) usage_deploy ;;
    *)
      printf "%bError:%b Unknown environment '%s'. Use 'dev' or 'prod'\n" "${RED}" "${NORMAL}" "${cmd_deploy_env}" >&2
      usage_deploy 1
      ;;
  esac

  cmd_deploy_dry_run=false
  cmd_deploy_is_bootstrap=false
  cmd_deploy_stage=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)
        cmd_deploy_dry_run=true
        shift
        ;;
      --bootstrap)
        cmd_deploy_is_bootstrap=true
        shift
        ;;
      --stage)
        if [ $# -lt 2 ]; then
          printf "%bError:%b Missing value for --stage\n" "${RED}" "${NORMAL}" >&2
          exit 1
        fi
        cmd_deploy_stage="$2"
        shift 2
        ;;
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
      help | --help | -h) usage_deploy ;;
      *)
        printf "%bError:%b Unexpected argument for deploy: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_deploy 1
        ;;
    esac
  done

  if [ "${cmd_deploy_is_bootstrap}" = "true" ]; then
    cmd_deploy_kustomize_path="${REPO_ROOT}/k3s/base/helm-charts"
  else
    cmd_deploy_kustomize_path="${REPO_ROOT}/k3s/overlays/${cmd_deploy_env}"
  fi

  if [ ! -d "${cmd_deploy_kustomize_path}" ]; then
    printf "%bError:%b Directory not found: %s\n" "${RED}" "${NORMAL}" "${cmd_deploy_kustomize_path}" >&2
    return 1
  fi

  if [ "${cmd_deploy_dry_run}" = "false" ]; then
    cmd_deploy_context=$(kubectl config current-context)
    if [ "${cmd_deploy_is_bootstrap}" = "true" ]; then
      printf "%bBootstrap %s to cluster: %s%b [y/n] " "${BOLD}" "${cmd_deploy_env}" "${cmd_deploy_context}" "${NORMAL}"
    else
      printf "%bDeploy %s to cluster: %s%b [y/n] " "${BOLD}" "${cmd_deploy_env}" "${cmd_deploy_context}" "${NORMAL}"
    fi
    read -r cmd_deploy_response
    if [ "${cmd_deploy_response}" != "y" ]; then
      echo "Skipping deploy"
      return 0
    fi
  fi

  cmd_deploy_template_vars=$(cmd_deploy_get_template_vars "${cmd_deploy_env}" "${cmd_deploy_stage}") || return 1

  cmd_deploy_rendered=$(cmd_deploy_render_templated_yaml "${cmd_deploy_kustomize_path}" "${cmd_deploy_template_vars}" "${cmd_deploy_is_bootstrap}")

  if [ "${cmd_deploy_dry_run}" = "true" ]; then
    if [ "${cmd_deploy_is_bootstrap}" = "true" ]; then
      printf "%b# Rendered output for bootstrap%b\n" "${BOLD}" "${NORMAL}"
    else
      printf "%b# Rendered output for %s%b\n" "${BOLD}" "${cmd_deploy_env}" "${NORMAL}"
    fi
    printf '%s\n' "${cmd_deploy_rendered}"
    return 0
  fi

  printf "Applying to cluster...\n"
  printf '%s' "${cmd_deploy_rendered}" | kubectl apply --server-side -f -

  if [ "${cmd_deploy_is_bootstrap}" = "true" ]; then
    cmd_deploy_wait_for_crds
    printf "%b Bootstrap complete%b\n" "${GREEN}" "${NORMAL}"
  else
    printf "%b Deploy %s complete%b\n" "${GREEN}" "${cmd_deploy_env}" "${NORMAL}"
  fi
}
