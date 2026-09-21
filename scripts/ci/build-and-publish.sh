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
  printf "Usage: %s <image-filters|chart-filters|image-matrix|chart-matrix|tag>\n" "$0" >&2
  printf "  tag <branch>              Select and validate a moving tag\n" >&2
  printf "  tag <branch> --normalize  Normalize a branch name without origin checks\n" >&2
  exit "${1:-0}"
}

normalize_tag() {
  local branch="$1" tag

  tag=$(printf '%s' "${branch}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9._-][^a-z0-9._-]*/-/g' \
    | cut -c1-63)

  case "${tag}" in
    '' | [!a-z0-9_]* | *[!a-z0-9_.-]*)
      die "Branch cannot form a valid image tag: ${branch}"
      ;;
    latest | sha-*)
      die "Branch maps to reserved image tag: ${tag}"
      ;;
    *) ;;
  esac

  printf "%s\n" "${tag}"
}

cmd_filters() {
  local catalog="$1" kind="$2"

  printf '%s\n' "${catalog}" | jq -c --arg kind "${kind}" '
    {"rebuild-all": .["rebuild-all"]}
    + (.[$kind] | map({key: .name, value: .watch}) | from_entries)
  '
}

# Create a build matrix from the catalog and workflow selection inputs.
#
# Arguments:
#   $1 catalog: JSON object containing rebuild-all, images, and charts.
#   $2 kind: images | charts.
#   $3 selection: paths-filter name array or workflow_dispatch input object.
cmd_matrix() {
  local catalog="$1" kind="$2" selection="$3"

  [ -n "${catalog}" ] || die "Catalog is required"
  [ -n "${selection}" ] || die "Selection is required"
  case "${kind}" in
    images | charts) ;;
    *) die "Unknown matrix kind: ${kind}" ;;
  esac

  printf '%s\n' "${catalog}" | jq -c \
    --arg kind "${kind}" \
    --argjson selection "${selection}" '
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
    '
}

cmd_tag() {
  local branch="$1"
  [ -n "${branch}" ] || die "Branch is required"

  if [ "${2:-}" = "--normalize" ]; then
    normalize_tag "${branch}"
    return
  fi
  [ $# -eq 1 ] || usage 1

  local refs
  refs=$(git -C "${REPO_ROOT}" ls-remote --symref origin HEAD 'refs/heads/*') \
    || die "Unable to enumerate origin branches"

  local default_branch
  default_branch=$(printf '%s\n' "${refs}" | awk '
    $1 == "ref:" && $2 ~ /^refs\/heads\// && $3 == "HEAD" {
      sub("^refs/heads/", "", $2); print $2
    }
  ')
  [ -n "${default_branch}" ] || die "Unable to determine origin's default branch"

  if [ "${branch}" = "${default_branch}" ]; then
    printf "latest\n"
    return
  fi

  local tag branches candidate candidate_tag branch_found=false
  tag=$(normalize_tag "${branch}")
  branches=$(printf '%s\n' "${refs}" | awk '
    $1 != "ref:" && $2 ~ /^refs\/heads\// {
      sub("^refs/heads/", "", $2); print $2
    }
  ')

  while IFS= read -r candidate; do
    if [ -z "${candidate}" ] || [ "${candidate}" = "${default_branch}" ]; then
      continue
    elif [ "${candidate}" = "${branch}" ]; then
      branch_found=true
      continue
    fi

    candidate_tag=$(normalize_tag "${candidate}")
    if [ "${candidate_tag}" = "${tag}" ]; then
      die "Image tag collision: ${branch} and ${candidate} both normalize to ${tag}"
    fi
  done <<< "${branches}"

  [ "${branch_found}" = "true" ] || die "Source branch is not published on origin: ${branch}"
  printf "%s\n" "${tag}"
}

main() {
  [ $# -ge 1 ] || usage 1
  local cmd="$1" catalog
  shift

  case "${cmd}" in
    image-filters)
      [ $# -eq 1 ] || usage 1
      catalog="$1"
      [ -n "${catalog}" ] || die "Catalog is required"
      cmd_filters "${catalog}" "images"
      ;;
    chart-filters)
      [ $# -eq 1 ] || usage 1
      catalog="$1"
      [ -n "${catalog}" ] || die "Catalog is required"
      cmd_filters "${catalog}" "charts"
      ;;
    image-matrix)
      [ $# -eq 2 ] || usage 1
      cmd_matrix "$1" "images" "$2"
      ;;
    chart-matrix)
      [ $# -eq 2 ] || usage 1
      cmd_matrix "$1" "charts" "$2"
      ;;
    tag)
      [ $# -ge 1 ] && [ $# -le 2 ] || usage 1
      if [ "$1" = "--normalize" ]; then
        [ $# -eq 2 ] || usage 1
        cmd_tag "$2" "$1"
      else
        cmd_tag "$@"
      fi
      ;;

    help | --help | -h)
      [ $# -eq 0 ] || usage 1
      usage
      ;;
    *) usage 1 ;;
  esac
}

main "$@"
