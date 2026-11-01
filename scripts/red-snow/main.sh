#!/bin/sh
set -eu

RED_SNOW_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${RED_SNOW_DIR}/../.." && pwd)

# shellcheck source=../lib/font.sh
. "${REPO_ROOT}/scripts/lib/font.sh"
# shellcheck source=../lib/log.sh
. "${REPO_ROOT}/scripts/lib/log.sh"
# shellcheck source=./usage.sh
. "${RED_SNOW_DIR}/usage.sh"

API="https://api.deepinfra.com"
SPEC_FILE="${REPO_ROOT}/apps/functions/src/api/deepinfra/deployment.json"

# DeepInfra API key is a provider credential, so it comes from the environment.
main_require_key() {
  [ -n "${DEEPINFRA_API_KEY:-}" ] || die "DEEPINFRA_API_KEY is not set"
}

main_full_name() {
  printf 'Pandoks/%s' "$(jq -r '.model_name' "${SPEC_FILE}")"
}

main_api() {
  main_api_method="$1"
  main_api_path="$2"
  shift 2
  curl -fsS -X "${main_api_method}" \
    -H "Authorization: Bearer ${DEEPINFRA_API_KEY}" \
    -H 'Content-Type: application/json' \
    "${API}${main_api_path}" "$@"
}

# Print the deploy_id of the live (non-deleted) red-snow deployment, empty if none.
main_deploy_id() {
  main_deploy_id_full=$(main_full_name)
  main_api GET /deploy/list \
    | jq -r --arg name "${main_deploy_id_full}" \
      'map(select(.model_name == $name and .status != "deleted")) | (.[0].deploy_id // "")'
}

cmd_up() {
  main_require_key
  cmd_up_id=$(main_deploy_id)
  if [ -n "${cmd_up_id}" ]; then
    die "already exists (${cmd_up_id}); use 'wake' to start it or 'status' to inspect it"
  fi
  cmd_up_body=$(jq '. + {settings: {min_instances: 1, max_instances: 1}}' "${SPEC_FILE}")
  main_api POST /deploy/llm -d "${cmd_up_body}" \
    | jq -r '"created \(.deploy_id) (\(.status))"'
  log_ok "deployment creating; first load takes ~12 min"
}

cmd_wake() {
  main_require_key
  cmd_wake_id=$(main_deploy_id)
  [ -n "${cmd_wake_id}" ] || die "no deployment; run 'up' first"
  main_api PUT "/deploy/${cmd_wake_id}" -d '{"settings":{"min_instances":1,"max_instances":1}}' > /dev/null
  log_ok "waking ${cmd_wake_id}"
}

cmd_sleep() {
  main_require_key
  cmd_sleep_id=$(main_deploy_id)
  [ -n "${cmd_sleep_id}" ] || die "no deployment; nothing to sleep"
  main_api PUT "/deploy/${cmd_sleep_id}" -d '{"settings":{"min_instances":0,"max_instances":1}}' > /dev/null
  log_ok "scaling ${cmd_sleep_id} to zero"
}

cmd_status() {
  main_require_key
  main_full_name_value=$(main_full_name)
  main_api GET /deploy/list \
    | jq -r --arg name "${main_full_name_value}" \
      'map(select(.model_name == $name and .status != "deleted"))
       | if length == 0 then "no live deployment"
         else .[] | "\(.deploy_id)  \(.status)  min_instances=\(.settings.min_instances // "?")" end'
}

cmd_logs() {
  main_require_key
  cmd_logs_id=$(main_deploy_id)
  [ -n "${cmd_logs_id}" ] || die "no deployment"
  cmd_logs_from=$(($(date +%s) - 1800))
  main_api GET "/v1/deployment_logs/query?deploy_id=${cmd_logs_id}&from=${cmd_logs_from}&limit=1000"
}

cmd_delete() {
  main_require_key
  cmd_delete_id=$(main_deploy_id)
  [ -n "${cmd_delete_id}" ] || die "no deployment to delete"
  main_api DELETE "/deploy/${cmd_delete_id}" > /dev/null
  log_ok "deleted ${cmd_delete_id}"
}

cmd=${1:-}
[ "$#" -gt 0 ] && shift || true
case "${cmd}" in
  up) cmd_up "$@" ;;
  wake) cmd_wake "$@" ;;
  sleep) cmd_sleep "$@" ;;
  status) cmd_status "$@" ;;
  logs) cmd_logs "$@" ;;
  delete) cmd_delete "$@" ;;
  -h | --help | help | '') usage ;;
  *) usage_error "unknown command: ${cmd}" ;;
esac
