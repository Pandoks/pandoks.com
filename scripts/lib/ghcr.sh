# shellcheck shell=sh

# Return whether one GHCR manifest exists without conflating a definitive 404
# with authentication, throttling, server, or transport failures.
ghcr_manifest_http_status() {
  ghcr_manifest_http_status_repository="$1"
  ghcr_manifest_http_status_tag="$2"
  ghcr_manifest_http_status_token="$3"

  printf 'header = "Authorization: Bearer %s"\n' "${ghcr_manifest_http_status_token}" \
    | curl -sS --connect-timeout 10 --max-time 30 --config - \
      --head \
      --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
      --output /dev/null \
      --write-out '%{http_code}' \
      "https://ghcr.io/v2/${ghcr_manifest_http_status_repository}/manifests/${ghcr_manifest_http_status_tag}"
}

ghcr_manifest_exists() {
  ghcr_manifest_exists_repository="$1"
  ghcr_manifest_exists_tag="$2"
  ghcr_manifest_exists_token="$3"
  ghcr_manifest_exists_attempt=1

  while [ "${ghcr_manifest_exists_attempt}" -le 3 ]; do
    ghcr_manifest_exists_status=$(ghcr_manifest_http_status \
      "${ghcr_manifest_exists_repository}" \
      "${ghcr_manifest_exists_tag}" \
      "${ghcr_manifest_exists_token}") || ghcr_manifest_exists_status=transport-error
    case "${ghcr_manifest_exists_status}" in
      200) return 0 ;;
      404) return 1 ;;
      401 | 403)
        printf 'GHCR manifest check was denied for %s:%s (HTTP %s)\n' \
          "${ghcr_manifest_exists_repository}" \
          "${ghcr_manifest_exists_tag}" \
          "${ghcr_manifest_exists_status}" >&2
        return 2
        ;;
      429 | 5?? | transport-error)
        if [ "${ghcr_manifest_exists_attempt}" -eq 3 ]; then
          printf 'GHCR manifest check failed for %s:%s after retries (%s)\n' \
            "${ghcr_manifest_exists_repository}" \
            "${ghcr_manifest_exists_tag}" \
            "${ghcr_manifest_exists_status}" >&2
          return 2
        fi
        sleep "${ghcr_manifest_exists_attempt}"
        ;;
      *)
        printf 'Unexpected GHCR response for %s:%s (HTTP %s)\n' \
          "${ghcr_manifest_exists_repository}" \
          "${ghcr_manifest_exists_tag}" \
          "${ghcr_manifest_exists_status}" >&2
        return 2
        ;;
    esac
    ghcr_manifest_exists_attempt=$((ghcr_manifest_exists_attempt + 1))
  done
}

ghcr_find_image_staging_tag() {
  ghcr_find_image_staging_tag_repository="$1"
  ghcr_find_image_staging_tag_key="$2"
  ghcr_find_image_staging_tag_sha="$3"
  ghcr_find_image_staging_tag_run_id="$4"
  ghcr_find_image_staging_tag_attempt="$5"
  ghcr_find_image_staging_tag_token="$6"

  while [ "${ghcr_find_image_staging_tag_attempt}" -ge 1 ]; do
    ghcr_find_image_staging_tag_candidate=$(image_cohort_staging_tag \
      "${ghcr_find_image_staging_tag_key}" \
      "${ghcr_find_image_staging_tag_sha}" \
      "${ghcr_find_image_staging_tag_run_id}" \
      "${ghcr_find_image_staging_tag_attempt}") || return 2
    if ghcr_manifest_exists \
      "${ghcr_find_image_staging_tag_repository}" \
      "${ghcr_find_image_staging_tag_candidate}" \
      "${ghcr_find_image_staging_tag_token}"; then
      printf '%s\n' "${ghcr_find_image_staging_tag_candidate}"
      return 0
    else
      ghcr_find_image_staging_tag_status=$?
      [ "${ghcr_find_image_staging_tag_status}" -eq 1 ] \
        || return "${ghcr_find_image_staging_tag_status}"
    fi
    ghcr_find_image_staging_tag_attempt=$((ghcr_find_image_staging_tag_attempt - 1))
  done
  return 1
}
