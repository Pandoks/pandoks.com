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
cmd_deploy() {
  [ $# -ge 1 ] || usage_deploy 1
  cmd_deploy_env="$1"
  shift

  while [ $# -gt 0 ]; do
    case "$1" in
      help | --help | -h) usage_deploy ;;
      *)
        printf "%bError:%b Unexpected argument for deploy: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_deploy 1
        ;;
    esac
  done

  case "${cmd_deploy_env}" in
    dev)
      # Skip confirmation if called from sync
      if [ "${cmd_deploy_no_confirm:-}" != "true" ]; then
        cmd_deploy_current_context=$(kubectl config current-context)
        printf "%bDeploy dev overlay to cluster: %s%b [y/n] " "${BOLD}" "${cmd_deploy_current_context}" "${NORMAL}"
        read -r cmd_deploy_confirm
        if [ "${cmd_deploy_confirm}" != "y" ]; then
          echo "Skipping deploy"
          return 0
        fi
      fi

      echo "Applying dev overlay..."
      kubectl kustomize "${REPO_ROOT}/k3s/overlays/dev" --load-restrictor LoadRestrictionsNone | kubectl apply --server-side -f -
      printf "%b✓ Dev overlay applied%b\n" "${GREEN}" "${NORMAL}"
      ;;
    prod)
      # Skip confirmation if called from sync
      if [ "${cmd_deploy_no_confirm:-}" != "true" ]; then
        cmd_deploy_current_context=$(kubectl config current-context)
        printf "%bDeploy prod overlay to cluster: %s%b [y/n] " "${BOLD}" "${cmd_deploy_current_context}" "${NORMAL}"
        read -r cmd_deploy_confirm
        if [ "${cmd_deploy_confirm}" != "y" ]; then
          echo "Skipping deploy"
          return 0
        fi
      fi

      echo "Applying prod overlay..."
      kubectl kustomize "${REPO_ROOT}/k3s/overlays/prod" --load-restrictor LoadRestrictionsNone | kubectl apply --server-side -f -
      printf "%b✓ Prod overlay applied%b\n" "${GREEN}" "${NORMAL}"
      ;;
    help | --help | -h) usage_deploy ;;
    *)
      printf "%bError:%b Unknown environment '%s'. Use 'dev' or 'prod'\n" "${RED}" "${NORMAL}" "${cmd_deploy_env}" >&2
      usage_deploy 1
      ;;
  esac
}
