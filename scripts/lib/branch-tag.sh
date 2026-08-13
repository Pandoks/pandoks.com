# shellcheck shell=sh

# Produce one branch key that is safe for Docker tags and Helm prerelease
# versions. The bounded slug is readable; the hash distinguishes branch names
# that normalize to the same slug.
branch_tag() {
  branch_tag_branch="$1"

  case "${branch_tag_branch}" in
    main | master)
      printf '%s\n' "${branch_tag_branch}"
      return 0
      ;;
  esac

  branch_tag_slug=$(printf '%s' "${branch_tag_branch}" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-//; s/-$//' \
    | LC_ALL=C cut -c1-54)
  [ -n "${branch_tag_slug}" ] || branch_tag_slug="branch"
  branch_tag_hash=$(printf '%s' "${branch_tag_branch}" | git hash-object --stdin | cut -c1-16)

  printf 'b-%s-%s\n' "${branch_tag_slug}" "${branch_tag_hash}"
}

image_cohort_tag() {
  image_cohort_tag_key="$1"
  image_cohort_tag_sha="$2"
  image_cohort_tag_run_id="$3"
  image_cohort_tag_run_attempt="$4"

  case "${image_cohort_tag_sha}" in
    *[!0-9a-f]* | '') return 1 ;;
  esac
  [ "${#image_cohort_tag_sha}" -eq 40 ] || return 1
  case "${image_cohort_tag_run_id}:${image_cohort_tag_run_attempt}" in
    *[!0-9:]* | :* | *:) return 1 ;;
  esac

  image_cohort_tag_value="ref-${image_cohort_tag_key}-$(printf '%s' "${image_cohort_tag_sha}" | cut -c1-12)-${image_cohort_tag_run_id}-${image_cohort_tag_run_attempt}"
  [ "${#image_cohort_tag_value}" -le 125 ] || return 1
  printf '%s\n' "${image_cohort_tag_value}"
}

image_cohort_staging_tag() {
  image_cohort_staging_tag_value="try-$(image_cohort_tag "$@")" || return 1
  [ "${#image_cohort_staging_tag_value}" -le 128 ] || return 1
  printf '%s\n' "${image_cohort_staging_tag_value}"
}

image_cohort_tag_is_valid_for_key() {
  image_cohort_tag_is_valid_key="$1"
  image_cohort_tag_is_valid_tag="$2"
  image_cohort_tag_is_valid_prefix="ref-${image_cohort_tag_is_valid_key}-"
  case "${image_cohort_tag_is_valid_tag}" in
    "${image_cohort_tag_is_valid_prefix}"*) ;;
    *) return 1 ;;
  esac
  image_cohort_tag_is_valid_suffix=${image_cohort_tag_is_valid_tag#"${image_cohort_tag_is_valid_prefix}"}
  image_cohort_tag_is_valid_sha=${image_cohort_tag_is_valid_suffix%%-*}
  image_cohort_tag_is_valid_run_attempt=${image_cohort_tag_is_valid_suffix#*-}
  [ "${image_cohort_tag_is_valid_run_attempt}" != "${image_cohort_tag_is_valid_suffix}" ] || return 1
  image_cohort_tag_is_valid_run_id=${image_cohort_tag_is_valid_run_attempt%%-*}
  image_cohort_tag_is_valid_attempt=${image_cohort_tag_is_valid_run_attempt#*-}
  [ "${image_cohort_tag_is_valid_attempt}" != "${image_cohort_tag_is_valid_run_attempt}" ] || return 1
  case "${image_cohort_tag_is_valid_sha}" in
    *[!0-9a-f]* | '') return 1 ;;
  esac
  [ "${#image_cohort_tag_is_valid_sha}" -eq 12 ] || return 1
  case "${image_cohort_tag_is_valid_run_id}:${image_cohort_tag_is_valid_attempt}" in
    *[!0-9:]* | :* | *: | *:*:*) return 1 ;;
  esac
}

image_cohort_marker_tag() {
  image_cohort_marker_tag_value="ok-$1"
  [ "${#image_cohort_marker_tag_value}" -le 128 ] || return 1
  printf '%s\n' "${image_cohort_marker_tag_value}"
}

# Transitional forms emitted before branch_tag() became canonical. Keep these
# only while deletion cleanup must remove artifacts published by older commits.
legacy_image_branch_tag() {
  printf '%s' "$1" | LC_ALL=C sed 's/[^a-zA-Z0-9._-][^a-zA-Z0-9._-]*/-/g'
}

legacy_chart_branch_tag() {
  # Helm stores SemVer build-metadata '+' as '_' in OCI tags.
  printf '%s' "$1" | LC_ALL=C sed 's|/|-|g; s|+|_|g'
}

image_branch_tag_is_unique() {
  image_branch_tag_is_unique_deleted="$1"
  image_branch_tag_is_unique_key="$2"
  image_branch_tag_is_unique_collision=false
  while IFS= read -r image_branch_tag_is_unique_survivor; do
    [ -n "${image_branch_tag_is_unique_survivor}" ] || continue
    if [ "${image_branch_tag_is_unique_survivor}" != "${image_branch_tag_is_unique_deleted}" ] \
      && { [ "$(branch_tag "${image_branch_tag_is_unique_survivor}")" = "${image_branch_tag_is_unique_key}" ] \
        || [ "$(legacy_image_branch_tag "${image_branch_tag_is_unique_survivor}")" = "${image_branch_tag_is_unique_key}" ]; }; then
      image_branch_tag_is_unique_collision=true
    fi
  done
  [ "${image_branch_tag_is_unique_collision}" = false ]
}

chart_branch_tag_is_unique() {
  chart_branch_tag_is_unique_deleted="$1"
  chart_branch_tag_is_unique_key="$2"
  chart_branch_tag_is_unique_collision=false
  while IFS= read -r chart_branch_tag_is_unique_survivor; do
    [ -n "${chart_branch_tag_is_unique_survivor}" ] || continue
    if [ "${chart_branch_tag_is_unique_survivor}" != "${chart_branch_tag_is_unique_deleted}" ] \
      && { [ "$(branch_tag "${chart_branch_tag_is_unique_survivor}")" = "${chart_branch_tag_is_unique_key}" ] \
        || [ "$(legacy_chart_branch_tag "${chart_branch_tag_is_unique_survivor}")" = "${chart_branch_tag_is_unique_key}" ]; }; then
      chart_branch_tag_is_unique_collision=true
    fi
  done
  [ "${chart_branch_tag_is_unique_collision}" = false ]
}
