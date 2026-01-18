# shellcheck shell=sh

cmd_sync() {
  [ $# -ge 1 ] || usage_sync 1
  cmd_sync_env="$1"
  shift

  case "${cmd_sync_env}" in
    dev | prod) ;;
    help | --help | -h) usage_sync ;;
    *)
      printf "%bError:%b Unknown environment '%s'. Use 'dev' or 'prod'\n" "${RED}" "${NORMAL}" "${cmd_sync_env}" >&2
      usage_sync 1
      ;;
  esac

  while [ $# -gt 0 ]; do
    case "$1" in
      help | --help | -h) usage_sync ;;
      *)
        printf "%bError:%b Unexpected argument for sync: %s\n" "${RED}" "${NORMAL}" "$1" >&2
        usage_sync 1
        ;;
    esac
  done

  cmd_sync_current_context=$(kubectl config current-context)
  printf "%bSync %s to cluster: %s%b [y/n] " "${BOLD}" "${cmd_sync_env}" "${cmd_sync_current_context}" "${NORMAL}"
  read -r cmd_sync_confirm
  if [ "${cmd_sync_confirm}" != "y" ]; then
    echo "Skipping sync"
    return 0
  fi

  export cmd_core_no_confirm=true
  cmd_core

  export cmd_deploy_no_confirm=true
  cmd_deploy "${cmd_sync_env}"

  printf "%b✓ Sync complete%b\n" "${GREEN}" "${NORMAL}"
}
