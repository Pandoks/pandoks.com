#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
BUCKET='dev-updates'
readonly SCRIPT_DIR
readonly REPO_ROOT
readonly BUCKET

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"

usage() {
  printf "%bUsage:%b pnpm updates <command> dev <app-dir> <channel> <runtime-version> <ios|android>...\n\n" "${BOLD}" "${NORMAL}" >&2
  printf "Publish Expo over-the-air updates to the updates Worker's R2 bucket.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bpublish%b    Export the app and serve it as the latest update\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %brollback%b   Send clients back to the update embedded in their build\n\n" "${GREEN}" "${NORMAL}" >&2

  printf "%bEnvironments:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bdev%b        %s bucket (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_DEFAULT_ACCOUNT_ID)\n\n" "${GREEN}" "${NORMAL}" "${BUCKET}" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  pnpm updates publish dev apps/mobile production 1.0.0 ios android\n" >&2
  printf "  pnpm updates rollback dev apps/mobile production 1.0.0 ios\n\n" >&2

  exit "${1:-0}"
}

put_object() {
  put_object_key="$1"
  put_object_file="$2"
  put_object_content_type="$3"

  # NOTE: the token goes in through stdin to keep it out of the process list
  curl --fail --silent --show-error --request PUT --header @- \
    --header "content-type: ${put_object_content_type}" --data-binary "@${put_object_file}" \
    "${OBJECTS_URL}/${put_object_key}" \
    > /dev/null << EOF
Authorization: Bearer ${CLOUDFLARE_API_TOKEN}
EOF
}

upload_asset() {
  upload_asset_file="$1"
  upload_asset_content_type="$2"
  upload_asset_extension="$3"

  upload_asset_hash="$(openssl dgst -sha256 -binary "${upload_asset_file}" | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  put_object "assets/${upload_asset_hash}" "${upload_asset_file}" "${upload_asset_content_type}"
  jq -n \
    --arg hash "${upload_asset_hash}" \
    --arg key "$(openssl dgst -md5 -r "${upload_asset_file}" | cut -d ' ' -f 1)" \
    --arg contentType "${upload_asset_content_type}" \
    --arg extension "${upload_asset_extension}" \
    '{ hash: $hash, key: $key, contentType: $contentType, url: "/assets/\($hash)" }
      + if $extension == "" then {} else { fileExtension: ".\($extension)" } end'
}

cmd_publish() {
  cmd_publish_export_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_publish_export_dir}"' EXIT

  set --
  for cmd_publish_platform in ${PLATFORMS}; do
    set -- "$@" --platform "${cmd_publish_platform}"
  done
  pnpm --dir "${APP_DIR}" exec expo export --output-dir "${cmd_publish_export_dir}" "$@"
  printf '%s' "${EXPO_CONFIG}" > "${cmd_publish_export_dir}/expo-config.json"

  for cmd_publish_platform in ${PLATFORMS}; do
    cmd_publish_launch_asset="$(upload_asset \
      "${cmd_publish_export_dir}/$(jq -r --arg platform "${cmd_publish_platform}" '.fileMetadata[$platform].bundle' "${cmd_publish_export_dir}/metadata.json")" \
      application/javascript '')"
    cmd_publish_assets="$(jq -r --arg platform "${cmd_publish_platform}" '.fileMetadata[$platform].assets[] | "\(.ext) \(.path)"' "${cmd_publish_export_dir}/metadata.json" \
      | while read -r cmd_publish_extension cmd_publish_path; do
        upload_asset "${cmd_publish_export_dir}/${cmd_publish_path}" \
          "$(file --brief --mime-type "${cmd_publish_export_dir}/${cmd_publish_path}")" "${cmd_publish_extension}"
      done | jq -s .)"

    jq -n \
      --arg id "$(uuidgen | tr '[:upper:]' '[:lower:]')" \
      --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
      --arg runtimeVersion "${RUNTIME_VERSION}" \
      --argjson launchAsset "${cmd_publish_launch_asset}" \
      --argjson assets "${cmd_publish_assets}" \
      --slurpfile expoClient "${cmd_publish_export_dir}/expo-config.json" \
      '{ id: $id, createdAt: $createdAt, runtimeVersion: $runtimeVersion, launchAsset: $launchAsset,
        assets: $assets, metadata: {}, extra: { expoClient: $expoClient[0] } }' \
      > "${cmd_publish_export_dir}/${cmd_publish_platform}.json"
    put_object "${UPDATE_PREFIX}/${cmd_publish_platform}.json" \
      "${cmd_publish_export_dir}/${cmd_publish_platform}.json" application/json
    log_ok "Published ${cmd_publish_platform} update to ${UPDATE_PREFIX}"
  done
}

cmd_rollback() {
  cmd_rollback_directive="$(mktemp)"
  trap 'rm -f "${cmd_rollback_directive}"' EXIT

  jq -n --arg commitTime "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{ type: "rollBackToEmbedded", parameters: { commitTime: $commitTime } }' > "${cmd_rollback_directive}"
  for cmd_rollback_platform in ${PLATFORMS}; do
    put_object "${UPDATE_PREFIX}/${cmd_rollback_platform}.json" "${cmd_rollback_directive}" application/json
    log_ok "Rolled ${cmd_rollback_platform} back to the embedded update in ${UPDATE_PREFIX}"
  done
}

main() {
  [ $# -ge 1 ] || usage 1
  cmd="$1"
  shift

  case "${cmd}" in
    publish | rollback) ;;
    help | --help | -h) usage ;;
    *)
      log_error "Unknown command '${cmd}'"
      usage 1
      ;;
  esac
  [ $# -ge 5 ] || usage 1

  if [ "$1" != dev ]; then
    log_error "Unknown environment '$1'. Use 'dev'"
    usage 1
  fi
  APP_DIR="$(CDPATH='' cd -- "$2" && pwd)"
  main_channel="$3"
  RUNTIME_VERSION="$4"
  shift 4
  for main_platform in "$@"; do
    case "${main_platform}" in
      ios | android) ;;
      *) die "Unknown platform '${main_platform}'. Use 'ios' or 'android'" ;;
    esac
  done
  PLATFORMS="$*"
  OBJECTS_URL="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_DEFAULT_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects"
  EXPO_CONFIG="$(pnpm --dir "${APP_DIR}" exec expo config --type public --json)"
  UPDATE_PREFIX="updates/$(printf '%s' "${EXPO_CONFIG}" | jq -r .slug)/${main_channel}/${RUNTIME_VERSION}"
  readonly APP_DIR RUNTIME_VERSION PLATFORMS OBJECTS_URL EXPO_CONFIG UPDATE_PREFIX

  "cmd_${cmd}"
}

main "$@"
