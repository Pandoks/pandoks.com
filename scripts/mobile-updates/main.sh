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
  printf "%bUsage:%b pnpm sst shell --stage <stage> -- pnpm mobile-updates publish <app-dir>\n\n" "${BOLD}" "${NORMAL}" >&2
  printf "Publish an Expo app's over-the-air update to the stage: its files to MobileUpdatesBucket and its\n" >&2
  printf "signed manifests to MobileUpdatesManifests. sst shell links both and loads CLOUDFLARE_API_TOKEN\n" >&2
  printf "and CLOUDFLARE_DEFAULT_ACCOUNT_ID from .env.<stage>. Production is published only by\n" >&2
  printf "deploy-infra.yaml on main.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bpublish%b   Export the app and serve it as the latest update\n\n" "${GREEN}" "${NORMAL}" >&2

  printf "%bExample:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  pnpm sst shell --stage pandoks -- pnpm mobile-updates publish apps/mobile-template\n\n" >&2

  exit "${1:-0}"
}

write_kv_value() {
  write_kv_value_namespace="$1"
  write_kv_value_key="$2"
  write_kv_value_file="$3"

  # NOTE: stdin keeps the token out of the process list
  curl --fail --silent --show-error --request PUT --header @- \
    --header "content-type: application/json" --data-binary "@${write_kv_value_file}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_DEFAULT_ACCOUNT_ID}/storage/kv/namespaces/${write_kv_value_namespace}/values/$(jq -rn --arg key "${write_kv_value_key}" '$key | @uri')" \
    > /dev/null << EOF
Authorization: Bearer ${CLOUDFLARE_API_TOKEN}
EOF
}

sign() {
  sign_key="$1"
  sign_file="$2"

  # NOTE: no pipe, since base64's success would hide a failed signing
  openssl dgst -sha256 -sign "${sign_key}" -out "${sign_file}.sig" "${sign_file}"
  openssl base64 -A -in "${sign_file}.sig"
}

queue_asset_upload() {
  queue_asset_upload_export_dir="$1"
  queue_asset_upload_bucket="$2"
  queue_asset_upload_assets_domain="$3"
  queue_asset_upload_path="$4"
  queue_asset_upload_content_type="$5"
  queue_asset_upload_extension="$6"
  queue_asset_upload_file="${queue_asset_upload_export_dir}/${queue_asset_upload_path}"

  queue_asset_upload_hash="$(openssl dgst -sha256 -binary "${queue_asset_upload_file}" | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  # NOTE: platforms share most assets, so each uploads once
  if ! grep -qsxF "${queue_asset_upload_hash}" "${queue_asset_upload_export_dir}/asset-hashes.txt"; then
    printf '%s\n' "${queue_asset_upload_hash}" >> "${queue_asset_upload_export_dir}/asset-hashes.txt"
    # NOTE: curl resets options between uploads, so every entry repeats them, fail included
    cat >> "${queue_asset_upload_export_dir}/uploads.curlrc" << EOF
next
url = "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_DEFAULT_ACCOUNT_ID}/r2/buckets/${queue_asset_upload_bucket}/objects/${queue_asset_upload_hash}"
upload-file = "${queue_asset_upload_file}"
header = "content-type: ${queue_asset_upload_content_type}"
expand-header = "Authorization: Bearer {{CLOUDFLARE_API_TOKEN}}"
fail
output = "/dev/null"
EOF
  fi
  jq -n \
    --arg hash "${queue_asset_upload_hash}" \
    --arg key "$(openssl dgst -md5 -r "${queue_asset_upload_file}" | cut -d ' ' -f 1)" \
    --arg contentType "${queue_asset_upload_content_type}" \
    --arg url "https://${queue_asset_upload_assets_domain}/${queue_asset_upload_hash}" \
    --arg extension "${queue_asset_upload_extension}" \
    '{ hash: $hash, key: $key, contentType: $contentType, url: $url }
      + if $extension == "" then {} else { fileExtension: ".\($extension)" } end'
}

cmd_publish() {
  cmd_publish_app_dir="$1"
  cmd_publish_bucket="$2"
  cmd_publish_namespace="$3"
  cmd_publish_assets_domain="$4"
  cmd_publish_stage="$5"
  if [ "${cmd_publish_stage}" = production ] && [ "${GITHUB_ACTIONS:-}" != true ]; then
    die "Production publishes only from deploy-infra.yaml on main"
  fi
  cmd_publish_export_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_publish_export_dir}"' EXIT
  # NOTE: MOBILE_UPDATES_ENVIRONMENT=dev points builds at the dev host and changes their runtime version
  if [ "${cmd_publish_stage}" != production ]; then
    export MOBILE_UPDATES_ENVIRONMENT=dev
  fi

  pnpm --dir "${cmd_publish_app_dir}" exec expo export --output-dir "${cmd_publish_export_dir}" --platform ios --platform android
  pnpm --dir "${cmd_publish_app_dir}" exec expo config --type public --json > "${cmd_publish_export_dir}/expo-config.json"
  cmd_publish_slug="$(jq -er .slug "${cmd_publish_export_dir}/expo-config.json")"
  printf '%s' "${SST_RESOURCE_MobileUpdatesSigningKey}" | jq -er .value > "${cmd_publish_export_dir}/signing-key.pem"
  printf '{"type":"noUpdateAvailable"}' > "${cmd_publish_export_dir}/no-update.json"
  cmd_publish_no_update_signature="$(sign "${cmd_publish_export_dir}/signing-key.pem" "${cmd_publish_export_dir}/no-update.json")"
  cmd_publish_certificate="${cmd_publish_app_dir}/$(pnpm --dir "${cmd_publish_app_dir}" exec expo config --json | jq -er .updates.codeSigningCertificate)"
  openssl x509 -in "${cmd_publish_certificate}" -pubkey -noout > "${cmd_publish_export_dir}/public-key.pem"
  openssl dgst -sha256 -verify "${cmd_publish_export_dir}/public-key.pem" -signature "${cmd_publish_export_dir}/no-update.json.sig" \
    "${cmd_publish_export_dir}/no-update.json" > /dev/null \
    || die "MobileUpdatesSigningKey doesn't match ${cmd_publish_certificate}, so phones would reject the update"

  for cmd_publish_platform in ios android; do
    cmd_publish_runtime_version="$(pnpm --dir "${cmd_publish_app_dir}" exec expo-updates runtimeversion:resolve --platform "${cmd_publish_platform}" | jq -er .runtimeVersion)"
    cmd_publish_bundle="$(jq -er --arg platform "${cmd_publish_platform}" '.fileMetadata[$platform].bundle' "${cmd_publish_export_dir}/metadata.json")"
    cmd_publish_launch_asset="$(queue_asset_upload "${cmd_publish_export_dir}" "${cmd_publish_bucket}" "${cmd_publish_assets_domain}" "${cmd_publish_bundle}" application/javascript '')"
    jq -r --arg platform "${cmd_publish_platform}" '.fileMetadata[$platform].assets[] | "\(.ext) \(.path)"' \
      "${cmd_publish_export_dir}/metadata.json" > "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.txt"
    while read -r cmd_publish_extension cmd_publish_path; do
      cmd_publish_content_type="$(file --brief --mime-type "${cmd_publish_export_dir}/${cmd_publish_path}")"
      queue_asset_upload "${cmd_publish_export_dir}" "${cmd_publish_bucket}" "${cmd_publish_assets_domain}" "${cmd_publish_path}" "${cmd_publish_content_type}" "${cmd_publish_extension}"
    done < "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.txt" \
      > "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.json"

    # NOTE: every publish is a newer update, so a revert on main reaches phones running the reverted one
    jq -ncj \
      --arg id "$(node -p 'crypto.randomUUID()')" \
      --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
      --arg runtimeVersion "${cmd_publish_runtime_version}" \
      --argjson launchAsset "${cmd_publish_launch_asset}" \
      --slurpfile assets "${cmd_publish_export_dir}/${cmd_publish_platform}-assets.json" \
      --slurpfile expoClient "${cmd_publish_export_dir}/expo-config.json" \
      '{ id: $id, createdAt: $createdAt, runtimeVersion: $runtimeVersion, launchAsset: $launchAsset,
        assets: $assets, metadata: {}, extra: { expoClient: $expoClient[0] } }' \
      > "${cmd_publish_export_dir}/${cmd_publish_platform}-manifest.json"
    cmd_publish_manifest_signature="$(sign "${cmd_publish_export_dir}/signing-key.pem" "${cmd_publish_export_dir}/${cmd_publish_platform}-manifest.json")"
    jq -n \
      --rawfile manifest "${cmd_publish_export_dir}/${cmd_publish_platform}-manifest.json" \
      --arg manifestSignature "${cmd_publish_manifest_signature}" \
      --arg noUpdateSignature "${cmd_publish_no_update_signature}" \
      '{ id: ($manifest | fromjson | .id), manifest: $manifest, manifestSignature: $manifestSignature,
        noUpdateSignature: $noUpdateSignature }' \
      > "${cmd_publish_export_dir}/${cmd_publish_platform}-update.json"
    printf '%s\n' "${cmd_publish_slug}/${cmd_publish_platform}/${cmd_publish_runtime_version}" > "${cmd_publish_export_dir}/${cmd_publish_platform}-key.txt"
  done
  # NOTE: --variable keeps the token out of the process list and the config file
  curl --silent --show-error --parallel --variable %CLOUDFLARE_API_TOKEN --config "${cmd_publish_export_dir}/uploads.curlrc"

  # NOTE: written after the uploads, so no manifest names a missing file
  for cmd_publish_platform in ios android; do
    cmd_publish_key="$(cat "${cmd_publish_export_dir}/${cmd_publish_platform}-key.txt")"
    write_kv_value "${cmd_publish_namespace}" "${cmd_publish_key}" "${cmd_publish_export_dir}/${cmd_publish_platform}-update.json"
    log_ok "Published ${cmd_publish_key}"
  done
}

main() {
  [ $# -ge 1 ] || usage 1
  cmd="$1"
  shift

  case "${cmd}" in
    publish) ;;
    help | --help | -h) usage ;;
    *)
      log_error "Unknown command '${cmd}'"
      usage 1
      ;;
  esac
  [ $# -eq 1 ] || usage 1
  [ -n "${SST_RESOURCE_App:-}" ] && [ -n "${SST_RESOURCE_MobileUpdatesBucket:-}" ] \
    && [ -n "${SST_RESOURCE_MobileUpdatesManifests:-}" ] && [ -n "${SST_RESOURCE_MobileUpdatesAssetsDomain:-}" ] \
    && [ -n "${SST_RESOURCE_MobileUpdatesSigningKey:-}" ] \
    || die "Missing the stage's linked resources. Run it under 'pnpm sst shell --stage <stage> --'"

  "cmd_${cmd}" "$(CDPATH='' cd -- "$1" && pwd)" \
    "$(printf '%s' "${SST_RESOURCE_MobileUpdatesBucket}" | jq -er .name)" \
    "$(printf '%s' "${SST_RESOURCE_MobileUpdatesManifests}" | jq -er .namespaceId)" \
    "$(printf '%s' "${SST_RESOURCE_MobileUpdatesAssetsDomain}" | jq -er .value)" \
    "$(printf '%s' "${SST_RESOURCE_App}" | jq -er .stage)"
}

main "$@"
