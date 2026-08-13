# shellcheck shell=sh

QUIET=false

log_status() {
  [ "${QUIET}" = "true" ] && return 0
  printf "%s\n" "$*" >&2
}

cmd_deploy_ghcr_tags() {
  cmd_deploy_ghcr_tags_image="$1"
  cmd_deploy_ghcr_tags_token=$(curl -fsS --retry 3 --retry-all-errors \
    --connect-timeout 10 --max-time 30 \
    "https://ghcr.io/token?scope=repository:pandoks/${cmd_deploy_ghcr_tags_image}:pull" \
    | jq -er .token) || die "Unable to obtain a GHCR pull token for ${cmd_deploy_ghcr_tags_image}"
  cmd_deploy_ghcr_tags_last=""
  cmd_deploy_ghcr_tags_page=0
  while :; do
    cmd_deploy_ghcr_tags_page=$((cmd_deploy_ghcr_tags_page + 1))
    [ "${cmd_deploy_ghcr_tags_page}" -le 10 ] \
      || die "GHCR tag listing reached the 10000-tag cap for ${cmd_deploy_ghcr_tags_image}; refusing to guess whether more tags exist"
    cmd_deploy_ghcr_tags_response=$(printf 'header = "Authorization: Bearer %s"\n' \
      "${cmd_deploy_ghcr_tags_token}" \
      | curl -fsS --retry 3 --retry-all-errors --connect-timeout 10 --max-time 30 \
        --config - --get \
        --data-urlencode n=1000 \
        --data-urlencode "last=${cmd_deploy_ghcr_tags_last}" \
        "https://ghcr.io/v2/pandoks/${cmd_deploy_ghcr_tags_image}/tags/list") \
      || die "Unable to list GHCR tags for ${cmd_deploy_ghcr_tags_image}"
    printf '%s' "${cmd_deploy_ghcr_tags_response}" | jq -r '.tags[]?'
    cmd_deploy_ghcr_tags_count=$(printf '%s' "${cmd_deploy_ghcr_tags_response}" | jq '(.tags // []) | length')
    [ "${cmd_deploy_ghcr_tags_count}" -eq 1000 ] || break
    cmd_deploy_ghcr_tags_next=$(printf '%s' "${cmd_deploy_ghcr_tags_response}" | jq -er '.tags[-1]')
    [ "${cmd_deploy_ghcr_tags_next}" != "${cmd_deploy_ghcr_tags_last}" ] \
      || die "GHCR tag pagination did not advance for ${cmd_deploy_ghcr_tags_image}"
    cmd_deploy_ghcr_tags_last="${cmd_deploy_ghcr_tags_next}"
  done
}

cmd_deploy_load_image_tags() {
  cmd_deploy_image_tags=""
  for cmd_deploy_load_image_tags_image in \
    patroni pgbackrest valkey valkey-reconciler argocd-sst-plugin \
    clickhouse clickhouse-keeper clickhouse-backup; do
    cmd_deploy_load_image_tags_tags=$(cmd_deploy_ghcr_tags "${cmd_deploy_load_image_tags_image}")
    while IFS= read -r cmd_deploy_load_image_tags_tag; do
      [ -n "${cmd_deploy_load_image_tags_tag}" ] || continue
      cmd_deploy_image_tags="${cmd_deploy_image_tags}${cmd_deploy_load_image_tags_image}	${cmd_deploy_load_image_tags_tag}
"
    done << EOF
${cmd_deploy_load_image_tags_tags}
EOF
  done
}

cmd_deploy_ghcr_tag_complete() {
  cmd_deploy_ghcr_tag_complete_tag="$1"
  cmd_deploy_ghcr_tag_complete_found=0
  for cmd_deploy_ghcr_tag_complete_image in \
    patroni pgbackrest valkey valkey-reconciler argocd-sst-plugin \
    clickhouse clickhouse-keeper clickhouse-backup; do
    if printf '%b' "${cmd_deploy_image_tags}" \
      | awk -F '\t' -v image="${cmd_deploy_ghcr_tag_complete_image}" \
        -v tag="${cmd_deploy_ghcr_tag_complete_tag}" \
        '$1 == image && $2 == tag { found = 1 } END { exit !found }'; then
      cmd_deploy_ghcr_tag_complete_found=$((cmd_deploy_ghcr_tag_complete_found + 1))
    fi
  done
  [ "${cmd_deploy_ghcr_tag_complete_found}" -eq 8 ]
}

cmd_deploy_ghcr_tag_exists() {
  cmd_deploy_ghcr_tag_exists_image="$1"
  cmd_deploy_ghcr_tag_exists_tag="$2"
  printf '%b' "${cmd_deploy_image_tags}" \
    | awk -F '\t' -v image="${cmd_deploy_ghcr_tag_exists_image}" \
      -v tag="${cmd_deploy_ghcr_tag_exists_tag}" \
      '$1 == image && $2 == tag { found = 1 } END { exit !found }'
}

cmd_deploy_validate_image_cohort() {
  cmd_deploy_validate_image_cohort_key="$1"
  cmd_deploy_validate_image_cohort_tag="$2"
  image_cohort_tag_is_valid_for_key \
    "${cmd_deploy_validate_image_cohort_key}" "${cmd_deploy_validate_image_cohort_tag}" \
    || die "Invalid immutable image cohort ref"
  cmd_deploy_load_image_tags
  cmd_deploy_ghcr_tag_complete "${cmd_deploy_validate_image_cohort_tag}" \
    || die "Image cohort ref is not present on all eight package images"
  cmd_deploy_ghcr_tag_exists \
    valkey "$(image_cohort_marker_tag "${cmd_deploy_validate_image_cohort_tag}")" \
    || die "Image cohort ref has no completion marker"
}

cmd_deploy_find_image_cohort() {
  cmd_deploy_find_image_cohort_key="$1"
  cmd_deploy_find_image_cohort_candidates=$(printf '%b' "${cmd_deploy_image_tags}" \
    | awk -F '\t' '$1 == "valkey" { print $2 }' \
    | while IFS= read -r cmd_deploy_find_image_cohort_marker; do
      case "${cmd_deploy_find_image_cohort_marker}" in
        ok-ref-*) ;;
        *) continue ;;
      esac
      cmd_deploy_find_image_cohort_tag=${cmd_deploy_find_image_cohort_marker#ok-}
      if image_cohort_tag_is_valid_for_key \
        "${cmd_deploy_find_image_cohort_key}" "${cmd_deploy_find_image_cohort_tag}"; then
        cmd_deploy_find_image_cohort_suffix=${cmd_deploy_find_image_cohort_tag##*-}
        cmd_deploy_find_image_cohort_without_attempt=${cmd_deploy_find_image_cohort_tag%-*}
        cmd_deploy_find_image_cohort_run_id=${cmd_deploy_find_image_cohort_without_attempt##*-}
        printf '%s\t%s\t%s\n' \
          "${cmd_deploy_find_image_cohort_run_id}" \
          "${cmd_deploy_find_image_cohort_suffix}" \
          "${cmd_deploy_find_image_cohort_tag}"
      fi
    done | sort -t "$(printf '\t')" -k1,1nr -k2,2nr | cut -f3)

  while IFS= read -r cmd_deploy_find_image_cohort_tag; do
    [ -n "${cmd_deploy_find_image_cohort_tag}" ] || continue
    if cmd_deploy_ghcr_tag_complete "${cmd_deploy_find_image_cohort_tag}"; then
      printf '%s\n' "${cmd_deploy_find_image_cohort_tag}"
      return 0
    fi
  done << EOF
${cmd_deploy_find_image_cohort_candidates}
EOF
  return 1
}

cmd_deploy_find_legacy_image_cohort() {
  cmd_deploy_find_legacy_image_cohort_tag="$1"
  cmd_deploy_ghcr_tag_complete "${cmd_deploy_find_legacy_image_cohort_tag}" || return 1
  printf '%s\n' "${cmd_deploy_find_legacy_image_cohort_tag}"
}

cmd_deploy_remote_image_tag() {
  cmd_deploy_remote_image_tag_branch="$1"
  cmd_deploy_remote_image_tag_allow_legacy="$2"
  cmd_deploy_remote_image_tag_remote_refs=$(git ls-remote --heads origin) \
    || die "Unable to enumerate origin branches before selecting image tags"
  cmd_deploy_remote_image_tag_branches=$(printf '%s\n' "${cmd_deploy_remote_image_tag_remote_refs}" \
    | sed 's|^[^[:space:]]*[[:space:]]refs/heads/||')
  cmd_deploy_remote_image_tag_sha=$(printf '%s\n' "${cmd_deploy_remote_image_tag_remote_refs}" \
    | awk -v ref="refs/heads/${cmd_deploy_remote_image_tag_branch}" '$2 == ref { print $1; exit }')
  [ "${#cmd_deploy_remote_image_tag_sha}" -eq 40 ] \
    || die "Source branch is not published on origin: ${cmd_deploy_remote_image_tag_branch}"
  cmd_deploy_load_image_tags

  cmd_deploy_remote_image_tag_key=$(branch_tag "${cmd_deploy_remote_image_tag_branch}")
  if ! printf '%s\n' "${cmd_deploy_remote_image_tag_branches}" \
    | image_branch_tag_is_unique "${cmd_deploy_remote_image_tag_branch}" "${cmd_deploy_remote_image_tag_key}"; then
    die "Canonical image key ${cmd_deploy_remote_image_tag_key} collides with another origin branch"
  fi
  if cmd_deploy_find_image_cohort "${cmd_deploy_remote_image_tag_key}"; then
    return 0
  fi

  if [ "${cmd_deploy_remote_image_tag_allow_legacy}" = "true" ]; then
    cmd_deploy_remote_image_tag_prior="ref-${cmd_deploy_remote_image_tag_key}-${cmd_deploy_remote_image_tag_sha}"
    if cmd_deploy_find_legacy_image_cohort "${cmd_deploy_remote_image_tag_prior}"; then
      log_warn "Using the preceding immutable canonical image format; republish the branch to migrate"
      return 0
    fi
    cmd_deploy_remote_image_tag_legacy=$(legacy_image_branch_tag "${cmd_deploy_remote_image_tag_branch}")
    if ! printf '%s\n' "${cmd_deploy_remote_image_tag_branches}" \
      | image_branch_tag_is_unique "${cmd_deploy_remote_image_tag_branch}" "${cmd_deploy_remote_image_tag_legacy}"; then
      die "Legacy image key ${cmd_deploy_remote_image_tag_legacy} collides with another origin branch; republish this branch's cohort"
    fi
    cmd_deploy_remote_image_tag_legacy_full="ref-${cmd_deploy_remote_image_tag_legacy}-${cmd_deploy_remote_image_tag_sha}"
    if cmd_deploy_find_legacy_image_cohort "${cmd_deploy_remote_image_tag_legacy_full}"; then
      log_warn "Using a transitional immutable legacy image cohort; republish the branch to migrate"
      return 0
    fi
    cmd_deploy_remote_image_tag_legacy_short="ref-${cmd_deploy_remote_image_tag_legacy}-$(printf '%s' "${cmd_deploy_remote_image_tag_sha}" | cut -c1-7)"
    if cmd_deploy_find_legacy_image_cohort "${cmd_deploy_remote_image_tag_legacy_short}"; then
      log_warn "Using a transitional immutable legacy image cohort; republish the branch to migrate"
      return 0
    fi
  fi

  die "No marked complete immutable GHCR image cohort exists for branch ${cmd_deploy_remote_image_tag_branch}"
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
      cmd_deploy_compute_vars_image_tag="latest"
      ;;
    prod | dev)
      cmd_deploy_compute_vars_is_local="false"
      cmd_deploy_compute_vars_image_registry="ghcr.io/pandoks"
      if [ "${cmd_deploy_compute_vars_is_bootstrap}" = "true" ]; then
        cmd_deploy_compute_vars_image_tag="bootstrap-unused"
        [ "${cmd_deploy_compute_vars_env}" = "prod" ] \
          && cmd_deploy_compute_vars_use_proxy_protocol="true"
      else
        case "${cmd_deploy_compute_vars_env}" in
          dev)
            if [ -z "${cmd_deploy_compute_vars_branch}" ]; then
              log_error "A source branch is required for dev image selection"
              return 1
            fi
            cmd_deploy_compute_vars_image_tag=$(cmd_deploy_remote_image_tag \
              "${cmd_deploy_compute_vars_branch}" true) || return 1
            ;;
          prod)
            if [ -n "${PANDOKS_IMAGE_TAG:-}" ]; then
              cmd_deploy_validate_image_cohort main "${PANDOKS_IMAGE_TAG}" \
                || return 1
              cmd_deploy_compute_vars_image_tag="${PANDOKS_IMAGE_TAG}"
            else
              cmd_deploy_compute_vars_image_tag=$(cmd_deploy_remote_image_tag main false) \
                || return 1
            fi
            cmd_deploy_compute_vars_use_proxy_protocol="true"
            ;;
        esac
      fi
      ;;
  esac

  if [ -z "${cmd_deploy_compute_vars_image_tag:-}" ]; then
    log_error "Image tag resolution returned an empty value"
    return 1
  fi

  jq -n \
    --arg IsLocal "${cmd_deploy_compute_vars_is_local}" \
    --arg ImageRegistry "${cmd_deploy_compute_vars_image_registry}" \
    --arg ImageTag "${cmd_deploy_compute_vars_image_tag}" \
    --arg UseProxyProtocol "${cmd_deploy_compute_vars_use_proxy_protocol}" \
    '{
      IsLocal: $IsLocal,
      ImageRegistry: $ImageRegistry,
      ImageTag: $ImageTag,
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
  cmd_deploy_render_kustomize=$(kubectl kustomize "${cmd_deploy_render_kustomize_path}" --load-restrictor LoadRestrictionsNone)

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
