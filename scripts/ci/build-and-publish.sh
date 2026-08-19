#!/bin/sh

set -eu

usage() {
  printf "Usage: %s <image-matrix|chart-matrix|image-tag>\n" "$0" >&2
  exit "${1:-0}"
}

normalize_branch_tag() {
  normalize_branch_tag_branch="$1"
  printf '%s' "${normalize_branch_tag_branch}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9._-][^a-z0-9._-]*/-/g' \
    | cut -c1-63
}

cmd_image_matrix() {
  cmd_image_matrix_event_name="$1"
  cmd_image_matrix_dispatch="${2:-}"
  cmd_image_matrix_changes="${3:-[]}"
  cmd_image_matrix_scan_all="${4:-false}"

  cmd_image_matrix_catalog='[
    {"name":"patroni","path":"./packages/postgres/patroni/Dockerfile"},
    {"name":"pgbackrest","path":"./packages/postgres/pgbackrest/Dockerfile"},
    {"name":"valkey","path":"./packages/valkey/Dockerfile"},
    {"name":"valkey-reconciler","path":"./packages/valkey/reconciler/Dockerfile"},
    {"name":"argocd-sst-plugin","path":"./packages/argocd/Dockerfile"},
    {"name":"clickhouse","path":"./packages/clickhouse/clickhouse/Dockerfile"},
    {"name":"clickhouse-keeper","path":"./packages/clickhouse/keeper/Dockerfile"},
    {"name":"clickhouse-backup","path":"./packages/clickhouse/backup/Dockerfile"}
  ]'

  if [ "${cmd_image_matrix_event_name}" = "workflow_dispatch" ]; then
    : "${cmd_image_matrix_dispatch:?DISPATCH is required}"
    cmd_image_matrix_selected=$(printf '%s\n' "${cmd_image_matrix_dispatch}" | jq -c '
      to_entries
      | map(select(.value == true and (.key | endswith("-chart") | not)))
      | map(.key)
    ')
  elif [ "${cmd_image_matrix_scan_all}" = "true" ]; then
    cmd_image_matrix_selected=$(printf '%s\n' "${cmd_image_matrix_catalog}" | jq -c 'map(.name)')
  else
    cmd_image_matrix_selected="${cmd_image_matrix_changes}"
  fi

  cmd_image_matrix_images=$(printf '%s\n' "${cmd_image_matrix_catalog}" \
    | jq -c --argjson selected "${cmd_image_matrix_selected}" '
    map(select(.name as $name | $selected | index($name)))
  ')
  printf 'images=%s\n' "${cmd_image_matrix_images}"
}

cmd_chart_matrix() {
  cmd_chart_matrix_event_name="$1"
  cmd_chart_matrix_dispatch="${2:-}"
  cmd_chart_matrix_changes="${3:-[]}"
  cmd_chart_matrix_scan_all="${4:-false}"

  cmd_chart_matrix_catalog='[
    {"name":"postgres","path":"./packages/postgres/chart"},
    {"name":"valkey","path":"./packages/valkey/chart"},
    {"name":"clickhouse","path":"./packages/clickhouse/chart"}
  ]'

  if [ "${cmd_chart_matrix_event_name}" = "workflow_dispatch" ]; then
    : "${cmd_chart_matrix_dispatch:?DISPATCH is required}"
    cmd_chart_matrix_selected=$(printf '%s\n' "${cmd_chart_matrix_dispatch}" | jq -c '
      to_entries
      | map(select(.value == true and (.key | endswith("-chart"))))
      | map(.key | sub("-chart$"; ""))
    ')
    cmd_chart_matrix_scan_all=false
  else
    cmd_chart_matrix_selected="${cmd_chart_matrix_changes}"
  fi

  cmd_chart_matrix_charts=$(printf '%s\n' "${cmd_chart_matrix_catalog}" | jq -c \
    --argjson selected "${cmd_chart_matrix_selected}" \
    --argjson scan_all "${cmd_chart_matrix_scan_all}" '
      map(. + {publish: (.name as $name | $selected | index($name) != null)})
      | map(select($scan_all or .publish))
    ')
  printf 'charts=%s\n' "${cmd_chart_matrix_charts}"
}

cmd_image_tag() {
  cmd_image_tag_branch="$1"
  cmd_image_tag_default_branch="$2"

  if [ "${cmd_image_tag_branch}" = "${cmd_image_tag_default_branch}" ]; then
    printf "moving=latest\n"
    return
  fi

  cmd_image_tag_moving=$(normalize_branch_tag "${cmd_image_tag_branch}")
  case "${cmd_image_tag_moving}" in
    '' | [!a-z0-9_]* | *[!a-z0-9_.-]*)
      printf "Branch cannot form a valid image tag: %s\n" "${cmd_image_tag_branch}" >&2
      exit 1
      ;;
    *) ;;
  esac

  cmd_image_tag_remote_branches=$(git ls-remote --heads origin) || {
    printf "Unable to enumerate origin branches\n" >&2
    exit 1
  }
  cmd_image_tag_candidates=$(printf '%s\n' "${cmd_image_tag_remote_branches}" \
    | awk '{sub("refs/heads/", "", $2); print $2}')

  while IFS= read -r cmd_image_tag_candidate; do
    [ -n "${cmd_image_tag_candidate}" ] || continue
    [ "${cmd_image_tag_candidate}" = "${cmd_image_tag_branch}" ] && continue

    cmd_image_tag_candidate_tag=$(normalize_branch_tag "${cmd_image_tag_candidate}")
    if [ "${cmd_image_tag_candidate_tag}" = "${cmd_image_tag_moving}" ]; then
      printf "Image tag collision: %s and %s both normalize to %s\n" \
        "${cmd_image_tag_branch}" "${cmd_image_tag_candidate}" "${cmd_image_tag_moving}" >&2
      exit 1
    fi
  done << EOF
${cmd_image_tag_candidates}
EOF

  printf "moving=%s\n" "${cmd_image_tag_moving}"
}

main() {
  [ $# -eq 1 ] || usage 1
  cmd="$1"

  case "${cmd}" in
    image-matrix)
      : "${EVENT_NAME:?EVENT_NAME is required}"
      cmd_image_matrix \
        "${EVENT_NAME}" \
        "${DISPATCH:-}" \
        "${CHANGES:-[]}" \
        "${SCAN_ALL:-false}"
      ;;
    chart-matrix)
      : "${EVENT_NAME:?EVENT_NAME is required}"
      cmd_chart_matrix \
        "${EVENT_NAME}" \
        "${DISPATCH:-}" \
        "${CHANGES:-[]}" \
        "${SCAN_ALL:-false}"
      ;;
    image-tag)
      : "${BRANCH:?BRANCH is required}"
      : "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"
      cmd_image_tag "${BRANCH}" "${DEFAULT_BRANCH}"
      ;;
    help | --help | -h) usage ;;
    *) usage 1 ;;
  esac
}

main "$@"
