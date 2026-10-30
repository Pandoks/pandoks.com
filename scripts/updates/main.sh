#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."
readonly SCRIPT_DIR
readonly REPO_ROOT

. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"

usage() {
  printf "%bUsage:%b pnpm sst shell --stage <stage> -- pnpm updates <command> <app-dir> <channel> <ios|android>...\n\n" "${BOLD}" "${NORMAL}" >&2
  printf "Publish Expo over-the-air updates to the stage's updates bucket. sst shell links the stage's\n" >&2
  printf "UpdatesBucket and Updates Worker, and loads CLOUDFLARE_API_TOKEN and CLOUDFLARE_DEFAULT_ACCOUNT_ID\n" >&2
  printf "from .env.<stage>. Production is published only by deploy-infra.yaml on main.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bpublish%b    Export the app and serve it as the latest update\n" "${GREEN}" "${NORMAL}" >&2
  printf "  %brollback%b   Send clients back to the update embedded in their build\n\n" "${GREEN}" "${NORMAL}" >&2

  printf "%bExamples:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  pnpm sst shell --stage pandoks -- pnpm updates publish apps/mobile production ios android\n" >&2
  printf "  pnpm sst shell --stage pandoks -- pnpm updates rollback apps/mobile production ios\n\n" >&2

  exit "${1:-0}"
}

put_object() {
  put_object_key="$1"
  put_object_file="$2"
  put_object_content_type="$3"

  put_object_url="$(printf '%s' "${SST_RESOURCE_UpdatesBucket}" | jq -er \
    --arg account "${CLOUDFLARE_DEFAULT_ACCOUNT_ID}" --arg key "${put_object_key}" \
    '"https://api.cloudflare.com/client/v4/accounts/\($account)/r2/buckets/\(.name)/objects/\($key | split("/") | map(@uri) | join("/"))"')"
  # NOTE: the token goes in through stdin to keep it out of the process list
  curl --fail --silent --show-error --request PUT --header @- \
    --header "content-type: ${put_object_content_type}" --data-binary "@${put_object_file}" \
    "${put_object_url}" \
    > /dev/null << EOF
Authorization: Bearer ${CLOUDFLARE_API_TOKEN}
EOF
}

upload_asset() {
  upload_asset_export_dir="$1"
  upload_asset_path="$2"
  upload_asset_content_type="$3"
  upload_asset_extension="$4"

  upload_asset_digests="$(node -e 'const file = fs.readFileSync(process.argv[1]);
    console.log(crypto.createHash("sha256").update(file).digest("base64url"), crypto.createHash("md5").update(file).digest("hex"))' \
    "${upload_asset_export_dir}/${upload_asset_path}")"
  upload_asset_hash="${upload_asset_digests% *}"
  # NOTE: platforms share most assets, so each is uploaded once per run
  if ! grep -qsxF "${upload_asset_hash}" "${upload_asset_export_dir}/uploaded-hashes.txt"; then
    put_object "assets/${upload_asset_hash}" "${upload_asset_export_dir}/${upload_asset_path}" "${upload_asset_content_type}"
    printf '%s\n' "${upload_asset_hash}" >> "${upload_asset_export_dir}/uploaded-hashes.txt"
  fi
  printf '%s' "${SST_RESOURCE_Updates}" | jq -e \
    --arg hash "${upload_asset_hash}" \
    --arg key "${upload_asset_digests#* }" \
    --arg contentType "${upload_asset_content_type}" \
    --arg extension "${upload_asset_extension}" \
    '{ hash: $hash, key: $key, contentType: $contentType, url: "\(.url)/assets/\($hash)" }
      + if $extension == "" then {} else { fileExtension: ".\($extension)" } end'
}

resolve_runtime_version() {
  resolve_runtime_version_app_dir="$1"
  resolve_runtime_version_platform="$2"

  resolve_runtime_version_output="$(pnpm --dir "${resolve_runtime_version_app_dir}" exec expo-updates runtimeversion:resolve --platform "${resolve_runtime_version_platform}")"
  printf '%s' "${resolve_runtime_version_output}" | jq -er .runtimeVersion \
    || die "No ${resolve_runtime_version_platform} runtime version. Set runtimeVersion in the app config"
}

cmd_publish() {
  cmd_publish_app_dir="$1"
  cmd_publish_channel="$2"
  shift 2
  cmd_publish_platforms="$*"
  cmd_publish_export_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_publish_export_dir}"' EXIT

  set --
  for cmd_publish_platform in ${cmd_publish_platforms}; do
    set -- "$@" --platform "${cmd_publish_platform}"
  done
  pnpm --dir "${cmd_publish_app_dir}" exec expo export --output-dir "${cmd_publish_export_dir}" "$@"
  pnpm --dir "${cmd_publish_app_dir}" exec expo config --type public --json > "${cmd_publish_export_dir}/expo-config.json"
  cmd_publish_slug="$(jq -er .slug "${cmd_publish_export_dir}/expo-config.json")"

  for cmd_publish_platform in ${cmd_publish_platforms}; do
    cmd_publish_runtime_version="$(resolve_runtime_version "${cmd_publish_app_dir}" "${cmd_publish_platform}")"
    cmd_publish_bundle="$(jq -r --arg platform "${cmd_publish_platform}" '.fileMetadata[$platform].bundle' "${cmd_publish_export_dir}/metadata.json")"
    cmd_publish_launch_asset="$(upload_asset "${cmd_publish_export_dir}" "${cmd_publish_bundle}" application/javascript '')"
    jq -r --arg platform "${cmd_publish_platform}" '.fileMetadata[$platform].assets[] | "\(.ext) \(.path)"' \
      "${cmd_publish_export_dir}/metadata.json" > "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.txt"
    while read -r cmd_publish_extension cmd_publish_path; do
      cmd_publish_content_type="$(file --brief --mime-type "${cmd_publish_export_dir}/${cmd_publish_path}")"
      upload_asset "${cmd_publish_export_dir}" "${cmd_publish_path}" "${cmd_publish_content_type}" "${cmd_publish_extension}"
    done < "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.txt" \
      > "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.json"

    cmd_publish_id="$(node -p 'crypto.randomUUID()')"
    cmd_publish_created_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    jq -n \
      --arg id "${cmd_publish_id}" \
      --arg createdAt "${cmd_publish_created_at}" \
      --arg runtimeVersion "${cmd_publish_runtime_version}" \
      --argjson launchAsset "${cmd_publish_launch_asset}" \
      --slurpfile assets "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.json" \
      --slurpfile expoClient "${cmd_publish_export_dir}/expo-config.json" \
      '{ id: $id, createdAt: $createdAt, runtimeVersion: $runtimeVersion, launchAsset: $launchAsset,
        assets: $assets, metadata: {}, extra: { expoClient: $expoClient[0] } }' \
      > "${cmd_publish_export_dir}/${cmd_publish_platform}.json"
  done

  for cmd_publish_platform in ${cmd_publish_platforms}; do
    cmd_publish_key="updates/${cmd_publish_slug}/${cmd_publish_channel}/$(jq -r .runtimeVersion "${cmd_publish_export_dir}/${cmd_publish_platform}.json")/${cmd_publish_platform}.json"
    put_object "${cmd_publish_key}" "${cmd_publish_export_dir}/${cmd_publish_platform}.json" application/json
    log_ok "Published ${cmd_publish_key}"
  done
}

cmd_rollback() {
  cmd_rollback_app_dir="$1"
  cmd_rollback_channel="$2"
  shift 2
  cmd_rollback_platforms="$*"
  cmd_rollback_directive="$(mktemp)"
  trap 'rm -f "${cmd_rollback_directive}"' EXIT

  cmd_rollback_expo_config="$(pnpm --dir "${cmd_rollback_app_dir}" exec expo config --type public --json)"
  cmd_rollback_slug="$(printf '%s' "${cmd_rollback_expo_config}" | jq -er .slug)"
  cmd_rollback_commit_time="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  jq -n --arg commitTime "${cmd_rollback_commit_time}" \
    '{ type: "rollBackToEmbedded", parameters: { commitTime: $commitTime } }' > "${cmd_rollback_directive}"

  set --
  for cmd_rollback_platform in ${cmd_rollback_platforms}; do
    cmd_rollback_runtime_version="$(resolve_runtime_version "${cmd_rollback_app_dir}" "${cmd_rollback_platform}")"
    set -- "$@" "updates/${cmd_rollback_slug}/${cmd_rollback_channel}/${cmd_rollback_runtime_version}/${cmd_rollback_platform}.json"
  done
  for cmd_rollback_key in "$@"; do
    put_object "${cmd_rollback_key}" "${cmd_rollback_directive}" application/json
    log_ok "Rolled ${cmd_rollback_key} back to the embedded update"
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
  [ $# -ge 3 ] || usage 1
  [ -n "${SST_RESOURCE_UpdatesBucket:-}" ] && [ -n "${SST_RESOURCE_Updates:-}" ] \
    || die "Missing the stage's UpdatesBucket and Updates links. Run it under 'pnpm sst shell --stage <stage> --'"

  main_app_dir="$(CDPATH='' cd -- "$1" && pwd)"
  main_channel="$2"
  shift 2
  for main_platform in "$@"; do
    case "${main_platform}" in
      ios | android) ;;
      *) die "Unknown platform '${main_platform}'. Use 'ios' or 'android'" ;;
    esac
  done

  "cmd_${cmd}" "${main_app_dir}" "${main_channel}" "$@"
}

main "$@"
