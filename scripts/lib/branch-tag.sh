# shellcheck shell=sh

# Produce a readable, collision-resistant branch key that is safe for Docker
# tags and Helm prerelease versions.
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

image_ref_tag() {
  image_ref_tag_key="$1"
  image_ref_tag_sha="$2"

  case "${image_ref_tag_sha}" in
    *[!0-9a-f]* | '') return 1 ;;
  esac
  [ "${#image_ref_tag_sha}" -eq 40 ] || return 1

  printf 'ref-%s-%s\n' "${image_ref_tag_key}" "$(printf '%s' "${image_ref_tag_sha}" | cut -c1-12)"
}
