#!/bin/sh
# shellcheck shell=sh

set -eu

usage() {
  printf 'Usage: %s <image-matrix|chart-matrix|image-tag>\n' "$0" >&2
  exit "${1:-0}"
}

normalize_branch_tag() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9._-][^a-z0-9._-]*/-/g' \
    | cut -c1-63
}

cmd_image_matrix() {
  : "${EVENT_NAME:?EVENT_NAME is required}"

  catalog='[
    {"name":"patroni","path":"./packages/postgres/patroni/Dockerfile"},
    {"name":"pgbackrest","path":"./packages/postgres/pgbackrest/Dockerfile"},
    {"name":"valkey","path":"./packages/valkey/Dockerfile"},
    {"name":"valkey-reconciler","path":"./packages/valkey/reconciler/Dockerfile"},
    {"name":"argocd-sst-plugin","path":"./packages/argocd/Dockerfile"},
    {"name":"clickhouse","path":"./packages/clickhouse/clickhouse/Dockerfile"},
    {"name":"clickhouse-keeper","path":"./packages/clickhouse/keeper/Dockerfile"},
    {"name":"clickhouse-backup","path":"./packages/clickhouse/backup/Dockerfile"}
  ]'

  if [ "${EVENT_NAME}" = 'workflow_dispatch' ]; then
    selected=$(printf '%s\n' "${DISPATCH:?DISPATCH is required}" | jq -c '
      to_entries
      | map(select(.value == true and (.key | endswith("-chart") | not)))
      | map(.key)
    ')
  elif [ "${SCAN_ALL:-false}" = 'true' ]; then
    selected=$(printf '%s\n' "${catalog}" | jq -c 'map(.name)')
  else
    selected=${CHANGES:-[]}
  fi

  images=$(printf '%s\n' "${catalog}" | jq -c --argjson selected "${selected}" '
    map(select(.name as $name | $selected | index($name)))
  ')
  printf 'images=%s\n' "${images}"
}

cmd_chart_matrix() {
  : "${EVENT_NAME:?EVENT_NAME is required}"

  catalog='[
    {"name":"postgres","path":"./packages/postgres/chart"},
    {"name":"valkey","path":"./packages/valkey/chart"},
    {"name":"clickhouse","path":"./packages/clickhouse/chart"}
  ]'

  if [ "${EVENT_NAME}" = 'workflow_dispatch' ]; then
    selected=$(printf '%s\n' "${DISPATCH:?DISPATCH is required}" | jq -c '
      to_entries
      | map(select(.value == true and (.key | endswith("-chart"))))
      | map(.key | sub("-chart$"; ""))
    ')
    scan_all=false
  else
    selected=${CHANGES:-[]}
    scan_all=${SCAN_ALL:-false}
  fi

  charts=$(printf '%s\n' "${catalog}" | jq -c \
    --argjson selected "${selected}" \
    --argjson scan_all "${scan_all}" '
      map(. + {publish: (.name as $name | $selected | index($name) != null)})
      | map(select($scan_all or .publish))
    ')
  printf 'charts=%s\n' "${charts}"
}

cmd_image_tag() {
  : "${BRANCH:?BRANCH is required}"
  : "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"

  if [ "${BRANCH}" = "${DEFAULT_BRANCH}" ]; then
    printf 'moving=latest\n'
    return
  fi

  moving=$(normalize_branch_tag "${BRANCH}")
  case "${moving}" in
    '' | [!a-z0-9_]* | *[!a-z0-9_.-]*)
      printf 'Branch cannot form a valid image tag: %s\n' "${BRANCH}" >&2
      exit 1
      ;;
    *) ;;
  esac

  remote_branches=$(git ls-remote --heads origin) || {
    printf 'Unable to enumerate origin branches\n' >&2
    exit 1
  }
  candidates=$(printf '%s\n' "${remote_branches}" \
    | awk '{sub("refs/heads/", "", $2); print $2}')

  while IFS= read -r candidate; do
    [ -n "${candidate}" ] || continue
    [ "${candidate}" = "${BRANCH}" ] && continue

    candidate_tag=$(normalize_branch_tag "${candidate}")
    if [ "${candidate_tag}" = "${moving}" ]; then
      printf 'Image tag collision: %s and %s both normalize to %s\n' \
        "${BRANCH}" "${candidate}" "${moving}" >&2
      exit 1
    fi
  done << EOF
${candidates}
EOF

  printf 'moving=%s\n' "${moving}"
}

main() {
  [ $# -eq 1 ] || usage 1

  case "$1" in
    image-matrix) cmd_image_matrix ;;
    chart-matrix) cmd_chart_matrix ;;
    image-tag) cmd_image_tag ;;
    help | --help | -h) usage ;;
    *) usage 1 ;;
  esac
}

main "$@"
