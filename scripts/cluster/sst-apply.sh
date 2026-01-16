# shellcheck shell=sh

cmd_sst_apply() {
  [ $# -ge 1 ] || usage_sst_apply 1
  case "$1" in
    help | --help | -h) usage_sst_apply ;;
  esac
  cmd_sst_apply_target="$1"
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

  if [ "${cmd_sst_apply_target}" = "all" ]; then
    cmd_sst_apply_templates="
      ${REPO_ROOT}/k3s/helm-charts/templates.yaml
      ${REPO_ROOT}/k3s/core/templates.yaml
      ${REPO_ROOT}/k3s/apps/templates.yaml
    "
  else
    if [ ! -f "${cmd_sst_apply_target}" ]; then
      printf "%bError:%b Missing template file: %s\n" "${RED}" "${NORMAL}" "${cmd_sst_apply_target}" >&2
      return 1
    fi
    cmd_sst_apply_templates="${cmd_sst_apply_target}"
  fi

  cmd_sst_apply_current_kube_context=$(kubectl config current-context)
  printf "%bApplying SST templates to Kubernetes cluster: %s%b [y/n] " "${BOLD}" "${cmd_sst_apply_current_kube_context}" "${NORMAL}"
  read -r cmd_sst_apply_confirm
  if [ "${cmd_sst_apply_confirm}" != "y" ]; then
    echo "Skipping sst-apply"
    return 0
  fi

  echo "Fetching SST secrets..."
  cmd_sst_apply_secrets_json=$(get_sst_secrets)
  if [ -z "${cmd_sst_apply_secrets_json}" ]; then
    printf "%bError:%b Failed to fetch SST secrets. Make sure you're authenticated with SST.\n" "${RED}" "${NORMAL}" >&2
    printf "Try running: %bpnpm run sso%b.\n" "${BOLD}" "${NORMAL}" >&2
    return 1
  fi
  echo "SST secrets fetched"

  while IFS= read -r cmd_sst_apply_entry; do
    cmd_sst_apply_key="$(printf "%s" "${cmd_sst_apply_entry}" | jq -r '.key')"
    cmd_sst_apply_value="$(printf "%s" "${cmd_sst_apply_entry}" | jq -r '.value')"
    export "${cmd_sst_apply_key}"="${cmd_sst_apply_value}"
  done << EOF
$(printf "%s" "${cmd_sst_apply_secrets_json}" | jq -c 'to_entries[]')
EOF

  cmd_sst_apply_tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_sst_apply_tmp_dir}"' EXIT

  for cmd_sst_apply_template in ${cmd_sst_apply_templates}; do
    if [ ! -f "${cmd_sst_apply_template}" ]; then
      printf "%bWarning:%b Template not found: %s, skipping\n" "${YELLOW}" "${NORMAL}" "${cmd_sst_apply_template}" >&2
      continue
    fi

    echo "Rendering ${cmd_sst_apply_template}..."
    envsubst < "${cmd_sst_apply_template}" > "${cmd_sst_apply_tmp_dir}/rendered.yaml"

    echo "Applying to Kubernetes cluster..."
    kubectl apply --server-side -f "${cmd_sst_apply_tmp_dir}/rendered.yaml"
  done

  printf "%b✓ SST templates applied to Kubernetes cluster%b\n" "${GREEN}" "${NORMAL}"
}
