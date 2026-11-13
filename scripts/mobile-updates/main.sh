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
  printf "%bUsage:%b pnpm mobile-updates <command> [args]\n\n" "${BOLD}" "${NORMAL}" >&2
  printf "Publish an Expo app's over-the-air update to a stage: its files to MobileUpdatesBucket and its\n" >&2
  printf "signed manifests to MobileUpdatesManifests. Production is published only by deploy-infra.yaml\n" >&2
  printf "on main, which exports with no secrets and uploads without running the app's dependencies.\n\n" >&2

  printf "%bCommands:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  %bexport%b <app-dir> <stage> <export-dir>\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Export the app's update for the stage, with its config, certificate, and runtime versions\n" >&2
  printf "  %bupload%b <export-dir> <bucket> <kv-namespace-id> <assets-domain>\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Sign an exported update and serve it as the latest. Reads MOBILE_UPDATES_SIGNING_KEY,\n" >&2
  printf "      CLOUDFLARE_API_TOKEN, and CLOUDFLARE_DEFAULT_ACCOUNT_ID\n" >&2
  printf "  %bpublish%b <app-dir>\n" "${GREEN}" "${NORMAL}" >&2
  printf "      Export and upload to the stage of the sst shell it runs in, which links its resources and\n" >&2
  printf "      loads CLOUDFLARE_API_TOKEN and CLOUDFLARE_DEFAULT_ACCOUNT_ID from .env.<stage>\n\n" >&2

  printf "%bExample:%b\n" "${BOLD}" "${NORMAL}" >&2
  printf "  pnpm sst shell --stage pandoks -- pnpm mobile-updates publish templates/mobile\n\n" >&2

  exit "${1:-0}"
}

write_update_to_kv() {
  write_update_to_kv_namespace="$1"
  write_update_to_kv_key="$2"
  write_update_to_kv_file="$3"

  # NOTE: stdin keeps the token out of the process list
  curl --fail --silent --show-error --request PUT --header @- \
    --header "content-type: application/json" --data-binary "@${write_update_to_kv_file}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_DEFAULT_ACCOUNT_ID}/storage/kv/namespaces/${write_update_to_kv_namespace}/values/$(jq -rn --arg key "${write_update_to_kv_key}" '$key | @uri')" \
    > /dev/null << EOF
Authorization: Bearer ${CLOUDFLARE_API_TOKEN}
EOF
}

sign_file() {
  sign_file_key="$1"
  sign_file_path="$2"

  # NOTE: no pipe, since base64's success would hide a failed signing
  openssl dgst -sha256 -sign "${sign_file_key}" -out "${sign_file_path}.sig" "${sign_file_path}"
  openssl base64 -A -in "${sign_file_path}.sig"
}

add_manifest_asset() {
  add_manifest_asset_export_dir="$1"
  add_manifest_asset_work_dir="$2"
  add_manifest_asset_bucket="$3"
  add_manifest_asset_assets_domain="$4"
  add_manifest_asset_path="$5"
  add_manifest_asset_content_type="$6"
  add_manifest_asset_extension="$7"
  add_manifest_asset_file="${add_manifest_asset_export_dir}/${add_manifest_asset_path}"
  # NOTE: the export ran the app's dependencies, so its paths can't reach the key or quote out of the curl config
  case "${add_manifest_asset_path}" in
    /* | *..* | *[!A-Za-z0-9_./-]*) die "Unexpected path '${add_manifest_asset_path}' in metadata.json" ;;
  esac

  add_manifest_asset_hash="$(openssl dgst -sha256 -binary "${add_manifest_asset_file}" | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  # NOTE: platforms share most assets, so each uploads once
  if ! grep -qsxF "${add_manifest_asset_hash}" "${add_manifest_asset_work_dir}/asset-hashes.txt"; then
    printf '%s\n' "${add_manifest_asset_hash}" >> "${add_manifest_asset_work_dir}/asset-hashes.txt"
    # NOTE: curl resets options between uploads, so every entry repeats them, fail included
    cat >> "${add_manifest_asset_work_dir}/uploads.curlrc" << EOF
next
url = "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_DEFAULT_ACCOUNT_ID}/r2/buckets/${add_manifest_asset_bucket}/objects/${add_manifest_asset_hash}"
upload-file = "${add_manifest_asset_file}"
header = "content-type: ${add_manifest_asset_content_type}"
expand-header = "Authorization: Bearer {{CLOUDFLARE_API_TOKEN}}"
fail
output = "/dev/null"
EOF
  fi
  jq -n \
    --arg hash "${add_manifest_asset_hash}" \
    --arg key "$(openssl dgst -md5 -r "${add_manifest_asset_file}" | cut -d ' ' -f 1)" \
    --arg contentType "${add_manifest_asset_content_type}" \
    --arg url "https://${add_manifest_asset_assets_domain}/${add_manifest_asset_hash}" \
    --arg extension "${add_manifest_asset_extension}" \
    '{ hash: $hash, key: $key, contentType: $contentType, url: $url }
      + if $extension == "" then {} else { fileExtension: ".\($extension)" } end'
}

cmd_export() {
  cmd_export_app_dir="$(CDPATH='' cd -- "$1" && pwd)"
  cmd_export_stage="$2"
  mkdir -p -- "$3"
  cmd_export_dir="$(CDPATH='' cd -- "$3" && pwd)"
  # NOTE: MOBILE_UPDATES_ENVIRONMENT=dev points builds at the dev host and changes their runtime version
  if [ "${cmd_export_stage}" != production ]; then
    export MOBILE_UPDATES_ENVIRONMENT=dev
  fi

  pnpm --dir "${cmd_export_app_dir}" exec expo export --output-dir "${cmd_export_dir}" --platform ios --platform android
  pnpm --dir "${cmd_export_app_dir}" exec expo config --type public --json > "${cmd_export_dir}/expo-config.json"
  cmd_export_certificate="${cmd_export_app_dir}/$(pnpm --dir "${cmd_export_app_dir}" exec expo config --json | jq -er .updates.codeSigningCertificate)"
  cp "${cmd_export_certificate}" "${cmd_export_dir}/certificate.crt"
  for cmd_export_platform in ios android; do
    pnpm --dir "${cmd_export_app_dir}" exec expo-updates runtimeversion:resolve --platform "${cmd_export_platform}" \
      | jq -er .runtimeVersion > "${cmd_export_dir}/${cmd_export_platform}-runtime-version.txt"
  done
}

cmd_upload() {
  cmd_upload_export_dir="$(CDPATH='' cd -- "$1" && pwd)"
  cmd_upload_bucket="$2"
  cmd_upload_namespace="$3"
  cmd_upload_assets_domain="$4"
  [ -n "${MOBILE_UPDATES_SIGNING_KEY:-}" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_DEFAULT_ACCOUNT_ID:-}" ] \
    || die "Missing MOBILE_UPDATES_SIGNING_KEY, CLOUDFLARE_API_TOKEN, or CLOUDFLARE_DEFAULT_ACCOUNT_ID"
  cmd_upload_work_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_upload_work_dir}"' EXIT

  cmd_upload_slug="$(jq -er .slug "${cmd_upload_export_dir}/expo-config.json")"
  printf '%s\n' "${MOBILE_UPDATES_SIGNING_KEY}" > "${cmd_upload_work_dir}/signing-key.pem"
  printf '{"type":"noUpdateAvailable"}' > "${cmd_upload_work_dir}/no-update.json"
  cmd_upload_no_update_signature="$(sign_file "${cmd_upload_work_dir}/signing-key.pem" "${cmd_upload_work_dir}/no-update.json")"
  openssl x509 -in "${cmd_upload_export_dir}/certificate.crt" -pubkey -noout > "${cmd_upload_work_dir}/public-key.pem"
  openssl dgst -sha256 -verify "${cmd_upload_work_dir}/public-key.pem" -signature "${cmd_upload_work_dir}/no-update.json.sig" \
    "${cmd_upload_work_dir}/no-update.json" > /dev/null \
    || die "MOBILE_UPDATES_SIGNING_KEY doesn't match the app's certificate, so phones would reject the update"

  for cmd_upload_platform in ios android; do
    cmd_upload_runtime_version="$(cat "${cmd_upload_export_dir}/${cmd_upload_platform}-runtime-version.txt")"
    cmd_upload_bundle="$(jq -er --arg platform "${cmd_upload_platform}" '.fileMetadata[$platform].bundle' "${cmd_upload_export_dir}/metadata.json")"
    cmd_upload_launch_asset="$(add_manifest_asset "${cmd_upload_export_dir}" "${cmd_upload_work_dir}" "${cmd_upload_bucket}" "${cmd_upload_assets_domain}" "${cmd_upload_bundle}" application/javascript '')"
    jq -r --arg platform "${cmd_upload_platform}" '.fileMetadata[$platform].assets[] | "\(.ext) \(.path)"' \
      "${cmd_upload_export_dir}/metadata.json" > "${cmd_upload_work_dir}/${cmd_upload_platform}-assets.txt"
    while read -r cmd_upload_extension cmd_upload_path; do
      cmd_upload_content_type="$(file --brief --mime-type "${cmd_upload_export_dir}/${cmd_upload_path}")"
      add_manifest_asset "${cmd_upload_export_dir}" "${cmd_upload_work_dir}" "${cmd_upload_bucket}" "${cmd_upload_assets_domain}" "${cmd_upload_path}" "${cmd_upload_content_type}" "${cmd_upload_extension}"
    done < "${cmd_upload_work_dir}/${cmd_upload_platform}-assets.txt" \
      > "${cmd_upload_work_dir}/${cmd_upload_platform}-assets.json"

    # NOTE: every publish is a newer update, so a revert on main reaches phones running the reverted one
    jq -ncj \
      --arg id "$(node -p 'crypto.randomUUID()')" \
      --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
      --arg runtimeVersion "${cmd_upload_runtime_version}" \
      --argjson launchAsset "${cmd_upload_launch_asset}" \
      --slurpfile assets "${cmd_upload_work_dir}/${cmd_upload_platform}-assets.json" \
      --slurpfile expoClient "${cmd_upload_export_dir}/expo-config.json" \
      '{ id: $id, createdAt: $createdAt, runtimeVersion: $runtimeVersion, launchAsset: $launchAsset,
        assets: $assets, metadata: {}, extra: { expoClient: $expoClient[0] } }' \
      > "${cmd_upload_work_dir}/${cmd_upload_platform}-manifest.json"
    cmd_upload_manifest_signature="$(sign_file "${cmd_upload_work_dir}/signing-key.pem" "${cmd_upload_work_dir}/${cmd_upload_platform}-manifest.json")"
    jq -n \
      --rawfile manifest "${cmd_upload_work_dir}/${cmd_upload_platform}-manifest.json" \
      --arg manifestSignature "${cmd_upload_manifest_signature}" \
      --arg noUpdateSignature "${cmd_upload_no_update_signature}" \
      '{ id: ($manifest | fromjson | .id), manifest: $manifest, manifestSignature: $manifestSignature,
        noUpdateSignature: $noUpdateSignature }' \
      > "${cmd_upload_work_dir}/${cmd_upload_platform}-update.json"
    printf '%s\n' "${cmd_upload_slug}/${cmd_upload_platform}/${cmd_upload_runtime_version}" > "${cmd_upload_work_dir}/${cmd_upload_platform}-key.txt"
  done
  # NOTE: --variable keeps the token out of the process list and the config file
  curl --silent --show-error --parallel --fail-early --variable %CLOUDFLARE_API_TOKEN --config "${cmd_upload_work_dir}/uploads.curlrc"

  # NOTE: written after the uploads, so no manifest names a missing file
  for cmd_upload_platform in ios android; do
    cmd_upload_key="$(cat "${cmd_upload_work_dir}/${cmd_upload_platform}-key.txt")"
    write_update_to_kv "${cmd_upload_namespace}" "${cmd_upload_key}" "${cmd_upload_work_dir}/${cmd_upload_platform}-update.json"
    log_ok "Published ${cmd_upload_key}"
  done
}

cmd_publish() {
  [ -n "${SST_RESOURCE_App:-}" ] && [ -n "${SST_RESOURCE_MobileUpdatesBucket:-}" ] \
    && [ -n "${SST_RESOURCE_MobileUpdatesManifests:-}" ] && [ -n "${SST_RESOURCE_MobileUpdatesAssetsDomain:-}" ] \
    && [ -n "${SST_RESOURCE_MobileUpdatesSigningKey:-}" ] \
    || die "Missing the stage's linked resources. Run it under 'pnpm sst shell --stage <stage> --'"
  cmd_publish_stage="$(printf '%s' "${SST_RESOURCE_App}" | jq -er .stage)"
  if [ "${cmd_publish_stage}" = production ]; then
    die "Production publishes only from deploy-infra.yaml on main"
  fi
  cmd_publish_export_dir="$(mktemp -d)"
  trap 'rm -rf "${cmd_publish_export_dir}"' EXIT

  cmd_export "$1" "${cmd_publish_stage}" "${cmd_publish_export_dir}"
  MOBILE_UPDATES_SIGNING_KEY="$(printf '%s' "${SST_RESOURCE_MobileUpdatesSigningKey}" | jq -er .value)"
  # NOTE: a subshell, so upload's cleanup trap doesn't replace this one
  (
    cmd_upload "${cmd_publish_export_dir}" \
      "$(printf '%s' "${SST_RESOURCE_MobileUpdatesBucket}" | jq -er .name)" \
      "$(printf '%s' "${SST_RESOURCE_MobileUpdatesManifests}" | jq -er .namespaceId)" \
      "$(printf '%s' "${SST_RESOURCE_MobileUpdatesAssetsDomain}" | jq -er .value)"
  )
}

main() {
  [ $# -ge 1 ] || usage 1
  cmd="$1"
  shift

  case "${cmd}" in
    export) [ $# -eq 3 ] || usage 1 ;;
    upload) [ $# -eq 4 ] || usage 1 ;;
    publish) [ $# -eq 1 ] || usage 1 ;;
    help | --help | -h) usage ;;
    *)
      log_error "Unknown command '${cmd}'"
      usage 1
      ;;
  esac

  "cmd_${cmd}" "$@"
}

main "$@"
