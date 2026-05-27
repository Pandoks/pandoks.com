#!/usr/bin/env bash
# Entrypoint invoked by the BuilderStateMachine on a freshly-launched EC2
# instance. The SFN clones the repo into /opt/repo and then calls this script
# from packages/stealth-chromium. Environment provided by the SFN:
#   BUILD_ID                  -- SFN execution id, used in artifact key
#   BUILDER_CACHE_BUCKET      -- S3 bucket for chromium-src + ccache tarballs
#   BUILDER_ARTIFACTS_BUCKET  -- S3 bucket for the patched binary output
#
# What this script does:
#   1. mount /build on a fresh ext4 fs if a spare NVMe device exists (faster
#      than the root EBS volume for the 100GB Chromium tree)
#   2. setup.sh   -- fetch or restore Chromium source
#   3. apply.sh   -- overlays + anchor edits + GN args
#   4. build.sh   -- multi-hour autoninja
#   5. pack the built binary as chromium-148.tar.zst and upload to artifacts
#   6. on failure at any step, capture the tail of the build log so the
#      operator can diagnose without re-running.
set -euo pipefail

: "${BUILD_ID:?BUILD_ID must be set by the SFN}"
: "${BUILDER_CACHE_BUCKET:?BUILDER_CACHE_BUCKET must be set by the SFN}"
: "${BUILDER_ARTIFACTS_BUCKET:?BUILDER_ARTIFACTS_BUCKET must be set by the SFN}"

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/tmp/stealth-chromium-build-${BUILD_ID}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== sfn-build start ==="
echo " build id      : $BUILD_ID"
echo " cache bucket  : $BUILDER_CACHE_BUCKET"
echo " artifacts     : $BUILDER_ARTIFACTS_BUCKET"
echo " package root  : $PKG_ROOT"
date -u +"%Y-%m-%dT%H:%M:%SZ"

cleanup_on_failure() {
  echo "=== sfn-build FAILED -- uploading diagnostics ==="
  local s3_prefix="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
  # 1. The 1MB log tail — sometimes contains the error, sometimes not (siso's
  #    success-step chatter is dense; on a big compile failure the actual
  #    error gets pushed past the 1MB window by thousands of "F CXX ..."
  #    success lines reporting the in-flight steps).
  tail -c 1048576 "$LOG_FILE" \
    | aws s3 cp - "${s3_prefix}/build-failure.log" \
    || echo "(build-failure.log upload also failed)"
  # 2. siso's own failure dump — the canonical Chromium debugging entry point.
  #    Build 233333 demonstrated the 1MB log tail can't capture compiler
  #    errors when siso runs ahead with thousands of parallel compile jobs;
  #    these two siso files have the actual error.
  local siso_out="${APEX_CHROMIUM_WORK:-/build}/chromium/src/out/apex"
  if [ -f "${siso_out}/siso_failed_commands.sh" ]; then
    aws s3 cp "${siso_out}/siso_failed_commands.sh" \
      "${s3_prefix}/siso_failed_commands.sh" \
      || echo "(siso_failed_commands.sh upload failed)"
  fi
  if [ -f "${siso_out}/siso_output" ]; then
    tail -c 1048576 "${siso_out}/siso_output" \
      | aws s3 cp - "${s3_prefix}/siso_output.tail" \
      || echo "(siso_output upload failed)"
  fi
  # 3. Grep for the actual compiler error patterns and upload as a
  #    self-contained summary. -B 5 -A 30 captures the offending file +
  #    next 30 lines of error output (template stacks etc).
  if [ -f "${siso_out}/siso_output" ]; then
    grep -nB 5 -A 30 -E "^FAILED:|error:|undefined reference|fatal error" \
      "${siso_out}/siso_output" 2>/dev/null \
      | head -c 1048576 \
      | aws s3 cp - "${s3_prefix}/compile-errors.log" \
      || echo "(compile-errors.log upload failed)"
  fi
}
trap cleanup_on_failure ERR

# --- 1. set up /build on the root volume -----------------------------------
# The SFN sizes the root EBS volume at run time via $.storageSizeGib, so
# /build just lives on /. Earlier versions of this script tried to format a
# "spare" block device for /build, but on c7i/c8i/m*i instance families
# there are no instance-store NVMe drives, and on Ubuntu c7i the root disk
# (/dev/nvme0n1) reports an empty MOUNTPOINT in lsblk -d (its partitions
# carry the mounts), which made the auto-detect grab the live root and
# refuse to format it. Simpler is better: trust the SFN sizing.
sudo mkdir -p /build
sudo chown "$USER:$USER" /build
echo "[mount] /build on root volume; df:"
df -h /build
export APEX_CHROMIUM_WORK=/build

# --- 2,3,4: hand off to the existing scripts -------------------------------
"$PKG_ROOT/scripts/setup.sh"
"$PKG_ROOT/scripts/apply.sh"
"$PKG_ROOT/scripts/build.sh"

# --- 5. pack + upload artifact ---------------------------------------------
echo "=== packaging artifact ==="
CHROMIUM_VERSION="$(cat "$PKG_ROOT/chromium_version.txt")"
ARTIFACT="/tmp/chromium-${CHROMIUM_VERSION}.tar.zst"
OUT_DIR="$APEX_CHROMIUM_WORK/chromium/src/out/apex"
[ -f "$OUT_DIR/chrome" ] || { echo "ERROR: built chrome binary missing"; exit 1; }

# Whitelist the files an operator actually needs to run the binary -- skips
# the multi-GB of object files / test binaries that ninja leaves behind.
# Resolve which whitelisted entries actually exist (chrome_sandbox is gone in
# newer setuid-sandbox-disabled builds; skip silently if missing).
WHITELIST=(
  chrome
  chrome_100_percent.pak
  chrome_200_percent.pak
  chrome_crashpad_handler
  chrome_sandbox
  icudtl.dat
  locales
  resources.pak
  snapshot_blob.bin
  v8_context_snapshot.bin
)
TAR_INCLUDES=()
for entry in "${WHITELIST[@]}"; do
  if [ -e "$OUT_DIR/$entry" ]; then
    TAR_INCLUDES+=("$entry")
  fi
done
tar -c -C "$OUT_DIR" "${TAR_INCLUDES[@]}" \
  | zstd -19 --long=27 -T0 -o "$ARTIFACT"
KEY="${BUILD_ID}/chromium-${CHROMIUM_VERSION}.tar.zst"
echo "[upload] s3://${BUILDER_ARTIFACTS_BUCKET}/${KEY}"
aws s3 cp "$ARTIFACT" "s3://${BUILDER_ARTIFACTS_BUCKET}/${KEY}" \
  --metadata "chromium-version=${CHROMIUM_VERSION},build-id=${BUILD_ID}"

# also a small manifest the operator can curl to find the artifact
MANIFEST="$(jq -n \
  --arg ver "$CHROMIUM_VERSION" \
  --arg bid "$BUILD_ID" \
  --arg key "$KEY" \
  --arg size "$(stat -c%s "$ARTIFACT")" \
  '{version: $ver, buildId: $bid, key: $key, sizeBytes: ($size|tonumber)}')"
echo "$MANIFEST" \
  | aws s3 cp - "s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}/manifest.json" \
      --content-type application/json

trap - ERR
echo "=== sfn-build complete ==="
date -u +"%Y-%m-%dT%H:%M:%SZ"
