# shellcheck shell=sh

QUIET=false

log_status() {
  [ "${QUIET}" = "true" ] && return 0
  printf "%s\n" "$*" >&2
}

cmd_deploy_branch_tag() {
  cmd_deploy_branch_tag_branch="$1"
  cmd_deploy_branch_tag_value=$(printf '%s' "${cmd_deploy_branch_tag_branch}" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed 's/[^a-z0-9._-][^a-z0-9._-]*/-/g' \
    | LC_ALL=C cut -c1-63)
  case "${cmd_deploy_branch_tag_value}" in
    [a-z0-9_]*) ;;
    *) return 1 ;;
  esac
  printf '%s\n' "${cmd_deploy_branch_tag_value}"
}

cmd_deploy_remote_branch_tag() {
  cmd_deploy_remote_branch_tag_branch="$1"
  cmd_deploy_remote_branch_tag_remote_refs=$(git ls-remote --heads origin) \
    || die "Unable to enumerate origin branches before selecting an image tag"
  cmd_deploy_remote_branch_tag_sha=$(printf '%s\n' "${cmd_deploy_remote_branch_tag_remote_refs}" \
    | awk -v ref="refs/heads/${cmd_deploy_remote_branch_tag_branch}" '$2 == ref { print $1; exit }')
  [ "${#cmd_deploy_remote_branch_tag_sha}" -eq 40 ] \
    || die "Source branch is not published on origin: ${cmd_deploy_remote_branch_tag_branch}"
  cmd_deploy_branch_tag "${cmd_deploy_remote_branch_tag_branch}" \
    || die "Source branch cannot form a valid image tag: ${cmd_deploy_remote_branch_tag_branch}"
}

cmd_deploy_registry_digest() {
  cmd_deploy_registry_digest_image="$1"
  cmd_deploy_registry_digest_tag="$2"
  cmd_deploy_registry_digest_repo="pandoks/${cmd_deploy_registry_digest_image}"
  cmd_deploy_registry_digest_token=$(curl --retry 3 --retry-all-errors -fsSL \
    "https://ghcr.io/token?scope=repository:${cmd_deploy_registry_digest_repo}:pull" \
    | jq -er '.token') || return 1
  cmd_deploy_registry_digest_headers=$(mktemp)
  cmd_deploy_registry_digest_status=$(curl --retry 3 --retry-all-errors -sS \
    -o /dev/null -D "${cmd_deploy_registry_digest_headers}" -w '%{http_code}' \
    -H "Authorization: Bearer ${cmd_deploy_registry_digest_token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/${cmd_deploy_registry_digest_repo}/manifests/${cmd_deploy_registry_digest_tag}") \
    || {
      rm -f "${cmd_deploy_registry_digest_headers}"
      return 1
    }
  if [ "${cmd_deploy_registry_digest_status}" = "404" ]; then
    rm -f "${cmd_deploy_registry_digest_headers}"
    return 2
  elif [ "${cmd_deploy_registry_digest_status}" != "200" ]; then
    log_error "GHCR returned ${cmd_deploy_registry_digest_status} for ${cmd_deploy_registry_digest_image}:${cmd_deploy_registry_digest_tag}"
    rm -f "${cmd_deploy_registry_digest_headers}"
    return 1
  fi
  cmd_deploy_registry_digest_value=$(tr -d '\r' < "${cmd_deploy_registry_digest_headers}" \
    | awk 'tolower($1) == "docker-content-digest:" { print $2; exit }')
  rm -f "${cmd_deploy_registry_digest_headers}"
  case "${cmd_deploy_registry_digest_value}" in
    sha256:*[!a-f0-9]* | '') return 1 ;;
  esac
  [ "${#cmd_deploy_registry_digest_value}" -eq 71 ] || return 1
  printf '%s\n' "${cmd_deploy_registry_digest_value}"
}

cmd_deploy_locked_images() {
  cmd_deploy_locked_images_file="${REPO_ROOT}/k3s/images.lock.json"
  jq -e '
    keys == [
      "argocd-sst-plugin", "clickhouse", "clickhouse-backup", "clickhouse-keeper",
      "patroni", "pgbackrest", "valkey", "valkey-reconciler"
    ]
    and all(to_entries[]; . as $entry
      | $entry.value
      | test("^ghcr\\.io/pandoks/" + $entry.key + ":latest@sha256:[a-f0-9]{64}$"))
  ' "${cmd_deploy_locked_images_file}" > /dev/null \
    || die "Invalid production image lock: ${cmd_deploy_locked_images_file}"
  jq -c . "${cmd_deploy_locked_images_file}"
}

cmd_deploy_images() {
  cmd_deploy_images_env="$1"
  cmd_deploy_images_branch="${2:-}"
  cmd_deploy_images_locked=$(cmd_deploy_locked_images) || return 1

  if [ "${cmd_deploy_images_env}" = "local" ]; then
    printf '%s' "${cmd_deploy_images_locked}" \
      | jq -c 'with_entries(.value = "local-registry:5000/" + .key + ":latest")'
    return
  elif [ "${cmd_deploy_images_env}" = "prod" ] || [ -z "${cmd_deploy_images_branch}" ]; then
    printf '%s\n' "${cmd_deploy_images_locked}"
    return
  fi

  cmd_deploy_images_tag=$(cmd_deploy_remote_branch_tag "${cmd_deploy_images_branch}") || return 1
  cmd_deploy_images_resolved='{}'
  for cmd_deploy_images_name in $(printf '%s' "${cmd_deploy_images_locked}" | jq -r 'keys[]'); do
    if cmd_deploy_images_digest=$(cmd_deploy_registry_digest \
      "${cmd_deploy_images_name}" "${cmd_deploy_images_tag}"); then
      cmd_deploy_images_ref="ghcr.io/pandoks/${cmd_deploy_images_name}@${cmd_deploy_images_digest}"
    else
      cmd_deploy_images_status=$?
      [ "${cmd_deploy_images_status}" -eq 2 ] || return 1
      cmd_deploy_images_ref=$(printf '%s' "${cmd_deploy_images_locked}" \
        | jq -er --arg name "${cmd_deploy_images_name}" '.[$name]') || return 1
    fi
    cmd_deploy_images_resolved=$(printf '%s' "${cmd_deploy_images_resolved}" \
      | jq -c --arg name "${cmd_deploy_images_name}" --arg ref "${cmd_deploy_images_ref}" \
        '. + {($name): $ref}') || return 1
  done
  printf '%s\n' "${cmd_deploy_images_resolved}"
}

cmd_deploy_compute_vars() {
  cmd_deploy_compute_vars_env="$1"
  cmd_deploy_compute_vars_branch="${2:-}"
  cmd_deploy_compute_vars_is_bootstrap="${3:-false}"
  cmd_deploy_compute_vars_use_proxy_protocol="false"

  case "${cmd_deploy_compute_vars_env}" in
    local)
      cmd_deploy_compute_vars_is_local="true"
      cmd_deploy_compute_vars_image_registry="local-registry:5000"
      ;;
    prod | dev)
      cmd_deploy_compute_vars_is_local="false"
      cmd_deploy_compute_vars_image_registry="ghcr.io/pandoks"
      if [ "${cmd_deploy_compute_vars_is_bootstrap}" = "true" ]; then
        [ "${cmd_deploy_compute_vars_env}" = "prod" ] \
          && cmd_deploy_compute_vars_use_proxy_protocol="true"
      elif [ "${cmd_deploy_compute_vars_env}" = "dev" ] \
        && [ -z "${cmd_deploy_compute_vars_branch}" ]; then
        log_error "A source branch is required for dev image selection"
        return 1
      elif [ "${cmd_deploy_compute_vars_env}" = "prod" ]; then
        cmd_deploy_compute_vars_use_proxy_protocol="true"
      fi
      ;;
  esac

  cmd_deploy_compute_vars_images=$(cmd_deploy_images \
    "${cmd_deploy_compute_vars_env}" "${cmd_deploy_compute_vars_branch}") || return 1

  printf '%s' "${cmd_deploy_compute_vars_images}" | jq \
    --arg IsLocal "${cmd_deploy_compute_vars_is_local}" \
    --arg ImageRegistry "${cmd_deploy_compute_vars_image_registry}" \
    --arg UseProxyProtocol "${cmd_deploy_compute_vars_use_proxy_protocol}" \
    'def image_variable:
      split("-") | map((.[0:1] | ascii_upcase) + .[1:]) | join("") + "Image";
    with_entries(.key |= image_variable)
    + {
        IsLocal: $IsLocal,
        ImageRegistry: $ImageRegistry,
        UseProxyProtocol: $UseProxyProtocol
      }'
}

cmd_deploy_get_template_vars() {
  cmd_deploy_get_template_vars_env="$1"       # local|dev|prod
  cmd_deploy_get_template_vars_stage="${2:-}" # --stage <stage> equivalent
  cmd_deploy_get_template_vars_branch="${3:-}"
  cmd_deploy_get_template_vars_computed="${4:-}"

  if [ -n "${cmd_deploy_get_template_vars_stage}" ]; then
    log_status "Fetching SST resources for stage '${cmd_deploy_get_template_vars_stage}'..."
  else
    log_status "Fetching SST resources..."
  fi
  cmd_deploy_get_template_vars_sst=$(get_sst_resources "${cmd_deploy_get_template_vars_stage}")
  if [ -z "${cmd_deploy_get_template_vars_sst}" ]; then
    log_error "Failed to fetch SST resources. Make sure you're authenticated with SST."
    printf "Try running: %bpnpm sso%b.\n" "${BOLD}" "${NORMAL}" >&2
    return 1
  fi
  log_status "SST resources fetched"

  if [ -z "${cmd_deploy_get_template_vars_computed}" ]; then
    cmd_deploy_get_template_vars_computed=$(cmd_deploy_compute_vars \
      "${cmd_deploy_get_template_vars_env}" "${cmd_deploy_get_template_vars_branch}") \
      || return 1
  fi

  printf '%s' "${cmd_deploy_get_template_vars_sst}" \
    | jq --argjson computed "${cmd_deploy_get_template_vars_computed}" '. + $computed'
}

cmd_deploy_render_templated_yaml() {
  cmd_deploy_render_kustomize_path="$1"
  cmd_deploy_render_template_vars="$2"
  cmd_deploy_render_is_bootstrap="$3" # true|false

  if [ "${cmd_deploy_render_is_bootstrap}" = "true" ]; then
    log_status "Running kustomize on bootstrap..."
  else
    log_status "Running kustomize on overlay..."
  fi
  cmd_deploy_render_kustomize=$(kustomize build "${cmd_deploy_render_kustomize_path}" --load-restrictor LoadRestrictionsNone)

  log_status "Substituting template variables..."
  template_substitute "${cmd_deploy_render_kustomize}" "${cmd_deploy_render_template_vars}"
}

cmd_deploy_wait_for_crds() {
  cmd_deploy_wait_for_crds_env="${1:-}" # local|dev|prod

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

  if [ "${cmd_deploy_wait_for_crds_env}" = "prod" ]; then
    echo "Waiting for ArgoCD..."
    wait_for_crd "applications.argoproj.io" 180
    kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=300s || true
    kubectl -n argocd rollout status deploy/argocd-server --timeout=300s || true
    printf "%b  ArgoCD established%b\n" "${GREEN}" "${NORMAL}"
  fi

  [ "${cmd_deploy_wait_for_crds_env}" = "local" ] && return 0

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
  cmd_deploy_branch=""
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
          die "Missing value for --stage"
        fi
        cmd_deploy_stage="$2"
        shift 2
        ;;
      --branch)
        if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#-}" != "$2" ]; then
          die "Missing value for --branch"
        fi
        cmd_deploy_branch="$2"
        shift 2
        ;;
      --kubeconfig)
        if [ $# -lt 2 ]; then
          die "Missing value for --kubeconfig"
        fi
        KUBECONFIG="$(validate_and_get_absolute_kubeconfig_path "$2")"
        export KUBECONFIG
        printf "%bUsing kubeconfig:%b %s\n" "${BOLD}" "${NORMAL}" "${KUBECONFIG}" >&2
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
  if [ "${cmd_deploy_is_bootstrap}" = "true" ] && [ -n "${cmd_deploy_branch}" ]; then
    die "--branch is not used with --bootstrap"
  elif [ "${cmd_deploy_env}" = "dev" ] \
    && [ "${cmd_deploy_is_bootstrap}" = "false" ] \
    && [ -z "${cmd_deploy_branch}" ]; then
    cmd_deploy_branch=$(git symbolic-ref --quiet --short HEAD) \
      || die "Detached HEAD has no source branch; pass --branch <published-branch>"
  elif [ "${cmd_deploy_env}" != "dev" ] && [ -n "${cmd_deploy_branch}" ]; then
    die "--branch is only valid for dev deployments"
  fi
  if [ -n "${cmd_deploy_branch}" ] \
    && ! git check-ref-format "refs/heads/${cmd_deploy_branch}" > /dev/null 2>&1; then
    die "Invalid source branch: ${cmd_deploy_branch}"
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

  cmd_deploy_computed_vars=$(cmd_deploy_compute_vars \
    "${cmd_deploy_env}" "${cmd_deploy_branch}" "${cmd_deploy_is_bootstrap}") || return 1

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

  cmd_deploy_template_vars=$(cmd_deploy_get_template_vars "${cmd_deploy_env}" "${cmd_deploy_stage}" "${cmd_deploy_branch}" "${cmd_deploy_computed_vars}") || return 1

  cmd_deploy_rendered=$(cmd_deploy_render_templated_yaml "${cmd_deploy_kustomize_path}" "${cmd_deploy_template_vars}" "${cmd_deploy_is_bootstrap}")

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
    cmd_deploy_wait_for_crds "${cmd_deploy_env}"
    printf "%b Bootstrap complete%b\n" "${GREEN}" "${NORMAL}"
  else
    printf "%b Deploy %s complete%b\n" "${GREEN}" "${cmd_deploy_env}" "${NORMAL}"
  fi
}
