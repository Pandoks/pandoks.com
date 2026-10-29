# shellcheck shell=sh

QUIET=false

deploy_get_template_vars() {
  deploy_get_template_vars_stage="${1:-}" # --stage <stage> equivalent

  if [ -n "${deploy_get_template_vars_stage}" ]; then
    log_info --quiet="${QUIET}" "Fetching SST resources for stage '${deploy_get_template_vars_stage}'..."
  else
    log_info --quiet="${QUIET}" "Fetching SST resources..."
  fi

  deploy_get_template_vars_sst=$(get_sst_resources "${deploy_get_template_vars_stage}")
  if [ -z "${deploy_get_template_vars_sst}" ]; then
    log_error "Failed to fetch SST resources. Make sure you're authenticated with SST."
    printf "Try running: %bpnpm sso%b.\n" "${BOLD}" "${NORMAL}" >&2
    return 1
  fi

  log_info --quiet="${QUIET}" "SST resources fetched"
  printf '%s\n' "${deploy_get_template_vars_sst}"
}

deploy_render_templated_yaml() {
  deploy_render_templated_yaml_kustomize_path="$1"
  deploy_render_templated_yaml_template_vars="$2"
  deploy_render_templated_yaml_is_bootstrap="$3" # true|false

  if [ "${deploy_render_templated_yaml_is_bootstrap}" = "true" ]; then
    log_info --quiet="${QUIET}" "Running kustomize on bootstrap..."
  else
    log_info --quiet="${QUIET}" "Running kustomize on overlay..."
  fi

  deploy_render_templated_yaml_kustomize=$(kustomize build \
    "${deploy_render_templated_yaml_kustomize_path}" --load-restrictor LoadRestrictionsNone)

  log_info --quiet="${QUIET}" "Substituting template variables..."
  template_substitute "${deploy_render_templated_yaml_kustomize}" "${deploy_render_templated_yaml_template_vars}"
}

deploy_wait_for_crds() {
  deploy_wait_for_crds_env="${1:-}" # local|dev|prod

  printf "Waiting for CRDs to be established...\n"

  echo "Waiting for cert-manager CRDs..."
  for deploy_wait_for_crds_crd in \
    certificates.cert-manager.io \
    issuers.cert-manager.io \
    clusterissuers.cert-manager.io; do
    wait_for_crd "${deploy_wait_for_crds_crd}" 180
  done
  printf "%b  cert-manager CRDs established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for cert-manager deployments..."
  wait_for_rollout cert-manager cert-manager 300
  wait_for_rollout cert-manager cert-manager-webhook 300
  wait_for_rollout cert-manager cert-manager-cainjector 300
  printf "%b  cert-manager deployments established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for MetalLB CRDs..."
  wait_for_crd "ipaddresspools.metallb.io" 120
  wait_for_crd "l2advertisements.metallb.io" 120
  wait_for_rollout metallb-system metallb-controller 300
  printf "%b  MetalLB CRDs established%b\n" "${GREEN}" "${NORMAL}"

  echo "Waiting for Prometheus Operator CRDs..."
  wait_for_crd "servicemonitors.monitoring.coreos.com" 180
  printf "%b  Prometheus Operator CRDs established%b\n" "${GREEN}" "${NORMAL}"

  if [ "${deploy_wait_for_crds_env}" = "prod" ]; then
    echo "Waiting for ArgoCD..."
    wait_for_crd "applications.argoproj.io" 180
    wait_for_rollout argocd argocd-repo-server 300
    wait_for_rollout argocd argocd-server 300
    printf "%b  ArgoCD established%b\n" "${GREEN}" "${NORMAL}"
  fi

  [ "${deploy_wait_for_crds_env}" = "local" ] && return 0

  echo "Waiting for system-upgrade-controller CRDs..."
  wait_for_crd "plans.upgrade.cattle.io" 120
  printf "%b  system-upgrade-controller CRDs established%b\n" "${GREEN}" "${NORMAL}"
}

cmd_deploy() {
  [ $# -ge 1 ] || usage_deploy 1
  cmd_deploy_env="$1"
  shift

  case "${cmd_deploy_env}" in
    local | dev | prod) ;;
    help | --help | -h) usage_deploy ;;
    *)
      log_error "Unknown environment '${cmd_deploy_env}'. Use 'local', 'dev', or 'prod'"
      usage_deploy 1
      ;;
  esac

  cmd_deploy_dry_run=false
  cmd_deploy_is_bootstrap=false
  cmd_deploy_stage=""
  cmd_deploy_kubeconfig=""

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
        [ $# -ge 2 ] || die "Missing value for --stage"

        cmd_deploy_stage="$2"
        shift 2
        ;;
      --kubeconfig)
        [ $# -ge 2 ] || die "Missing value for --kubeconfig"

        cmd_deploy_kubeconfig="$2"
        shift 2
        ;;
      --quiet | -q)
        QUIET=true
        shift
        ;;
      help | --help | -h) usage_deploy ;;
      *)
        log_error "Unexpected argument for deploy: $1"
        usage_deploy 1
        ;;
    esac
  done
  [ "${cmd_deploy_env}" = "prod" ] && cmd_deploy_stage="production"

  if [ -n "${cmd_deploy_kubeconfig}" ]; then
    KUBECONFIG="$(validate_and_get_absolute_kubeconfig_path "${cmd_deploy_kubeconfig}")"
    export KUBECONFIG
    log_info --quiet="${QUIET}" "Using kubeconfig: ${KUBECONFIG}"
  fi

  if [ "${cmd_deploy_is_bootstrap}" = "true" ]; then
    cmd_deploy_kustomize_path="${REPO_ROOT}/k3s/bootstrap/${cmd_deploy_env}"
  else
    cmd_deploy_kustomize_path="${REPO_ROOT}/k3s/overlays/${cmd_deploy_env}"
  fi

  if [ ! -d "${cmd_deploy_kustomize_path}" ]; then
    log_error "Directory not found: ${cmd_deploy_kustomize_path}"
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

  cmd_deploy_template_vars=$(deploy_get_template_vars "${cmd_deploy_stage}") || return 1

  cmd_deploy_rendered=$(deploy_render_templated_yaml "${cmd_deploy_kustomize_path}" "${cmd_deploy_template_vars}" "${cmd_deploy_is_bootstrap}")

  if [ "${cmd_deploy_dry_run}" = "true" ]; then
    if [ "${QUIET}" = "false" ]; then
      if [ "${cmd_deploy_is_bootstrap}" = "true" ]; then
        printf "%b# Rendered output for bootstrap%b\n" "${BOLD}" "${NORMAL}"
      else
        printf "%b# Rendered output for %s%b\n" "${BOLD}" "${cmd_deploy_env}" "${NORMAL}"
      fi
    fi

    printf '%s\n' "${cmd_deploy_rendered}"
    return 0
  fi

  printf "Applying to cluster...\n"
  printf '%s' "${cmd_deploy_rendered}" | kubectl apply --server-side --force-conflicts -f -

  if [ "${cmd_deploy_is_bootstrap}" = "true" ]; then
    deploy_wait_for_crds "${cmd_deploy_env}"
    printf "%b Bootstrap complete%b\n" "${GREEN}" "${NORMAL}"
  else
    printf "%b Deploy %s complete%b\n" "${GREEN}" "${cmd_deploy_env}" "${NORMAL}"
  fi
}
