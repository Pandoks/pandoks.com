#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"

usage() {
  printf "Usage: %s <image-filters|chart-filters|image-matrix|chart-matrix|image-tag>\n" "$0" >&2
  exit "${1:-0}"
}

normalize_branch_tag() {
  normalize_branch_tag_branch="$1"
  printf '%s' "${normalize_branch_tag_branch}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9._-][^a-z0-9._-]*/-/g' \
    | cut -c1-63
}

cmd_filters() {
  cmd_filters_catalog="$1"
  cmd_filters_kind="$2"

  cmd_filters_value=$(printf '%s\n' "${cmd_filters_catalog}" | jq -c --arg kind "${cmd_filters_kind}" '
    {"rebuild-all": .["rebuild-all"]}
    + (.[$kind] | map({key: .name, value: .watch}) | from_entries)
  ')
  printf '%s\n' "${cmd_filters_value}"
}

# Create a build matrix from the catalog and workflow selection inputs.
#
# Arguments:
#   $1 catalog: JSON object containing rebuild-all, images, and charts.
#   $2 kind: images | charts.
#   $3 selection: paths-filter name array or workflow_dispatch input object.
cmd_matrix() {
  cmd_matrix_catalog="$1"
  cmd_matrix_kind="$2"
  cmd_matrix_selection="$3"

  [ -n "${cmd_matrix_catalog}" ] || die "Catalog is required"
  [ -n "${cmd_matrix_selection}" ] || die "Selection is required"
  case "${cmd_matrix_kind}" in
    images | charts) ;;
    *) die "Unknown matrix kind: ${cmd_matrix_kind}" ;;
  esac

  cmd_matrix_value=$(printf '%s\n' "${cmd_matrix_catalog}" | jq -c \
    --arg kind "${cmd_matrix_kind}" \
    --argjson selection "${cmd_matrix_selection}" '
      ($selection | type) as $selection_type
      | if $selection_type != "array" and $selection_type != "object" then
          error("selection must be an array or object")
        else
          .
        end
      | (
          $selection
          | if $selection_type == "array" then
              .
            else
              to_entries
              | map(select(.value == true))
              | if $kind == "images" then
                  map(select(.key | endswith("-chart") | not) | .key)
                else
                  map(select(.key | endswith("-chart")) | .key | sub("-chart$"; ""))
                end
            end
        ) as $selected
      | ($selection_type == "array" and ($selected | index("rebuild-all") != null)) as $rebuild_all
      | if $kind == "images" then
        .images
        | if $rebuild_all then
            .
          else
            map(select(.name as $name | $selected | index($name)))
          end
        | map(del(.watch))
      else
        .charts
        | map(. + {publish: (.name as $name | $selected | index($name) != null)})
        | map(select($rebuild_all or .publish))
        | map(del(.watch))
      end
    ')
  printf '%s\n' "${cmd_matrix_value}"
}

cmd_image_tag() {
  cmd_image_tag_branch="$1"
  cmd_image_tag_default_branch="$2"

  [ -n "${cmd_image_tag_branch}" ] || die "Branch is required"
  [ -n "${cmd_image_tag_default_branch}" ] || die "Default branch is required"

  if [ "${cmd_image_tag_branch}" = "${cmd_image_tag_default_branch}" ]; then
    printf "latest\n"
    return
  fi

  cmd_image_tag_moving=$(normalize_branch_tag "${cmd_image_tag_branch}")
  case "${cmd_image_tag_moving}" in
    '' | [!a-z0-9_]* | *[!a-z0-9_.-]*)
      die "Branch cannot form a valid image tag: ${cmd_image_tag_branch}"
      ;;
    *) ;;
  esac

  cmd_image_tag_remote_branches=$(git ls-remote --heads origin) \
    || die "Unable to enumerate origin branches"
  cmd_image_tag_candidates=$(printf '%s\n' "${cmd_image_tag_remote_branches}" \
    | awk '{sub("refs/heads/", "", $2); print $2}')

  while IFS= read -r cmd_image_tag_candidate; do
    [ -n "${cmd_image_tag_candidate}" ] || continue
    [ "${cmd_image_tag_candidate}" = "${cmd_image_tag_branch}" ] && continue

    cmd_image_tag_candidate_tag=$(normalize_branch_tag "${cmd_image_tag_candidate}")
    if [ "${cmd_image_tag_candidate_tag}" = "${cmd_image_tag_moving}" ]; then
      die "Image tag collision: ${cmd_image_tag_branch} and ${cmd_image_tag_candidate} both normalize to ${cmd_image_tag_moving}"
    fi
  done << EOF
${cmd_image_tag_candidates}
EOF

  printf "%s\n" "${cmd_image_tag_moving}"
}

main() {
  [ $# -ge 1 ] || usage 1
  cmd="$1"
  shift

  case "${cmd}" in
    image-filters)
      [ $# -eq 1 ] || usage 1
      main_catalog="$1"
      [ -n "${main_catalog}" ] || die "Catalog is required"
      cmd_filters "${main_catalog}" "images"
      ;;
    chart-filters)
      [ $# -eq 1 ] || usage 1
      main_catalog="$1"
      [ -n "${main_catalog}" ] || die "Catalog is required"
      cmd_filters "${main_catalog}" "charts"
      ;;
    image-matrix)
      [ $# -eq 2 ] || usage 1
      cmd_matrix "$1" "images" "$2"
      ;;
    chart-matrix)
      [ $# -eq 2 ] || usage 1
      cmd_matrix "$1" "charts" "$2"
      ;;
    image-tag)
      [ $# -eq 2 ] || usage 1
      cmd_image_tag "$@"
      ;;
    help | --help | -h)
      [ $# -eq 0 ] || usage 1
      usage
      ;;
    *) usage 1 ;;
  esac
}

main "$@"
