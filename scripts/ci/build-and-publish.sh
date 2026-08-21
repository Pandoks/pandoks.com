#!/bin/bash
# shellcheck shell=bash

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

normalize_moving_tag() {
  normalize_moving_tag_branch="$1"

  normalize_moving_tag_value=$(printf '%s' "${normalize_moving_tag_branch}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9._-][^a-z0-9._-]*/-/g' \
    | cut -c1-63)

  case "${normalize_moving_tag_value}" in
    '' | [!a-z0-9_]* | *[!a-z0-9_.-]*)
      die "Branch cannot form a valid image tag: ${normalize_moving_tag_branch}"
      ;;
    latest | sha-*)
      die "Branch maps to reserved image tag: ${normalize_moving_tag_value}"
      ;;
    *) ;;
  esac

  printf "%s\n" "${normalize_moving_tag_value}"
}

remote_branches() {
  remote_branches_refs=$(git -C "${REPO_ROOT}" ls-remote --heads origin) \
    || die "Unable to enumerate origin branches"
  printf '%s\n' "${remote_branches_refs}" \
    | awk '{sub("refs/heads/", "", $2); print $2}'
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

cmd_moving_tag() {
  cmd_moving_tag_current_branch="$1"
  cmd_moving_tag_default_branch="$2"
  [ -n "${cmd_moving_tag_current_branch}" ] || die "Branch is required"
  [ -n "${cmd_moving_tag_default_branch}" ] || die "Default branch is required"

  if [ "${cmd_moving_tag_current_branch}" = "${cmd_moving_tag_default_branch}" ]; then
    printf "latest\n"
    return
  fi

  cmd_moving_tag_normalized_tag=$(normalize_moving_tag "${cmd_moving_tag_current_branch}")
  cmd_moving_tag_branches=$(remote_branches)
  cmd_moving_tag_origin_branch_found=false

  while IFS= read -r cmd_moving_tag_branch_candidate; do
    if [ -z "${cmd_moving_tag_branch_candidate}" ] \
      || [ "${cmd_moving_tag_branch_candidate}" = "${cmd_moving_tag_default_branch}" ]; then
      continue
    elif [ "${cmd_moving_tag_branch_candidate}" = "${cmd_moving_tag_current_branch}" ]; then
      cmd_moving_tag_origin_branch_found=true
      continue
    fi

    cmd_moving_tag_branch_candidate_moving_tag=$(normalize_moving_tag "${cmd_moving_tag_branch_candidate}")
    if [ "${cmd_moving_tag_branch_candidate_moving_tag}" = "${cmd_moving_tag_normalized_tag}" ]; then
      die "Image tag collision: ${cmd_moving_tag_current_branch} and ${cmd_moving_tag_branch_candidate} both normalize to ${cmd_moving_tag_normalized_tag}"
    fi
  done <<< "${cmd_moving_tag_branches}"

  [ "${cmd_moving_tag_origin_branch_found}" = "true" ] \
    || die "Source branch is not published on origin: ${cmd_moving_tag_current_branch}"
  printf "%s\n" "${cmd_moving_tag_normalized_tag}"
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
    moving-tag)
      [ $# -eq 2 ] || usage 1
      cmd_moving_tag "$@"
      ;;
    live-moving-tags)
      [ $# -eq 1 ] || usage 1
      cmd_live_moving_tags "$1"
      ;;
    help | --help | -h)
      [ $# -eq 0 ] || usage 1
      usage
      ;;
    *) usage 1 ;;
  esac
}

main "$@"
