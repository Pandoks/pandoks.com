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

# The runner's SSM shell starts with NO $HOME; gclient spams "Can't resolve
# $HOME" without it. Set it before anything runs.
export HOME="${HOME:-/root}"

# The generic runner (infra/runner/) exports RUNNER_JOB_ID / RUNNER_CACHE_BUCKET
# / RUNNER_ARTIFACTS_BUCKET; this script predates the builder->runner rename and
# reads the legacy names. Map new -> legacy AND export -- setup.sh/apply.sh/
# build.sh are child PROCESSES, so an unexported assignment leaves their
# BUILDER_CACHE_BUCKET empty, which makes setup.sh's cache guard false -> a false
# "cache MISS" -> a slow fresh gclient sync instead of restoring the warm cache.
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
: "${BUILDER_CACHE_BUCKET:=${RUNNER_CACHE_BUCKET:-}}"
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
export BUILD_ID BUILDER_CACHE_BUCKET BUILDER_ARTIFACTS_BUCKET

: "${BUILD_ID:?BUILD_ID (or RUNNER_JOB_ID) must be set by the SFN}"
: "${BUILDER_CACHE_BUCKET:?BUILDER_CACHE_BUCKET (or RUNNER_CACHE_BUCKET) must be set by the SFN}"
: "${BUILDER_ARTIFACTS_BUCKET:?BUILDER_ARTIFACTS_BUCKET (or RUNNER_ARTIFACTS_BUCKET) must be set by the SFN}"

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
  local siso_out="${APEX_CHROMIUM_WORK:-/build}/chromium/src/out/apex"
  # 2. Grep the FULL build log for the actual error. This is path-AGNOSTIC:
  #    works for both siso (out/apex/siso_output) and plain ninja (errors go
  #    inline to $LOG_FILE). We grep $LOG_FILE itself — it always exists and
  #    always contains the failed step's stderr, even when the 1MB tail (which
  #    captures the END of the log) missed it because success-chatter scrolled
  #    the error out of the last 1MB window.
  #    -B 5 -A 40 captures the offending command + the compiler/linker error
  #    block (template stacks, "FAILED:" gn-action output, etc.).
  {
    grep -nB 5 -A 40 -E "FAILED:|error:|undefined reference|fatal error|ninja: build stopped" \
      "$LOG_FILE" 2>/dev/null || echo "(no error pattern matched in build log)"
  } | head -c 1048576 \
    | aws s3 cp - "${s3_prefix}/compile-errors.log" \
    || echo "(compile-errors.log upload failed)"
  # Also grab siso's own dump when present (siso builds only — currently we
  # use plain ninja so these usually 404, harmless).
  if [ -f "${siso_out}/siso_failed_commands.sh" ]; then
    aws s3 cp "${siso_out}/siso_failed_commands.sh" \
      "${s3_prefix}/siso_failed_commands.sh" 2>/dev/null || true
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

# --- 4.5: assert the patches actually LINKED into the binary ---------------
# build.sh only proves it COMPILED. A patch can silently drop out (apply skip,
# stale ccache object, header misplacement) while the build still succeeds.
# This guard greps the binary for every env-var-gated patch string and aborts
# (-> ERR trap uploads diagnostics, no artifact) if any is missing -- so we
# never ship a half-patched, quietly-de-cloaking binary again.
"$PKG_ROOT/scripts/assert_binary_patched.sh"

# --- 4.6: runtime self-check (NON-FATAL) -----------------------------------
# assert_binary_patched.sh proves each patch's string LINKED into the binary;
# it cannot prove the patch actually FIRES, nor catch a runtime-only defect
# like the missing GL libs that once shipped a WebGL-less binary through a
# "successful" build. This launches the freshly built chrome and asserts it
# spoofs at runtime (navigator.platform, WebGL strings, 20+ surfaces, zero
# toString tampering). The builder has the GL libs right in out/apex, so WebGL
# verifies here too. STRICTLY non-fatal + timeout-bounded: a verifier hiccup
# must never fail an otherwise-good build (the string assert above is the hard
# gate), so its exit code is swallowed -- it only adds a runtime score to the
# log. Skips cleanly if uv isn't on the builder.
# The verdict is tee'd to a log and uploaded to the artifact prefix even on
# SUCCESS -- a green build's stdout is NOT persisted (SSM truncates to the
# first 2.5 KB; no CloudWatch group), so without this upload the self-check
# result (incl. the builder-side WebGL/WebGPU runtime outcome) is lost.
SELFCHECK_LOG="/tmp/runtime-selfcheck.log"
if command -v uv >/dev/null 2>&1; then
  echo "=== runtime self-check (non-fatal, HEADFUL on Xvfb) ==="
  # Headful-on-Xvfb is production's real mode -- and it's the ONLY way WebGL
  # routes through Mesa llvmpipe (MAX_TEXTURE_SIZE 16384, coherent) instead of
  # the --headless=new SwiftShader fallback (8192). So the self-check must run
  # under Xvfb to see production's real WebGL. Install xvfb if the builder
  # lacks it (non-fatal).
  command -v xvfb-run >/dev/null 2>&1 \
    || sudo apt-get install -y -qq xvfb >/dev/null 2>&1 || true
  APEX_CHROME_PATH="$APEX_CHROMIUM_WORK/chromium/src/out/apex/chrome" \
    timeout 360 xvfb-run -a -s "-screen 0 1920x1080x24" \
    uv run --project "$PKG_ROOT/../stealth-browser" \
    python "$PKG_ROOT/scripts/verify_patched_binary.py" 2>&1 \
    | tee "$SELFCHECK_LOG" \
    || echo "  (runtime self-check did not pass cleanly -- non-fatal, see above)"
else
  echo "=== runtime self-check skipped (no uv on builder) ===" | tee "$SELFCHECK_LOG"
fi
if [ -n "${BUILDER_ARTIFACTS_BUCKET:-}" ] && [ -s "$SELFCHECK_LOG" ]; then
  aws s3 cp "$SELFCHECK_LOG" \
    "s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}/runtime-selfcheck.log" \
    >/dev/null 2>&1 \
    || echo "  (self-check log upload failed -- non-fatal)"
fi

# --- 5. pack + upload artifact ---------------------------------------------
echo "=== packaging artifact ==="
CHROMIUM_VERSION="$("$PKG_ROOT/scripts/resolve-chromium-version.sh")"
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

# GL/Vulkan runtime libs: ANGLE (libEGL.so/libGLESv2.so) drives WebGL and
# SwiftShader (libvk_swiftshader.so + vk_swiftshader_icd.json, libvulkan.so.1)
# is the software path Dawn/WebGPU + WebGL fall back to on a GPU-less box.
# These live at the TOP of out/ (object files are under obj/), so a top-level
# .so/.so.N/_icd.json glob captures exactly the runtime libs with no stray
# objects. WITHOUT them the binary has NO working WebGL/WebGPU at all -- which
# is itself a glaring bot tell (real Chrome always renders WebGL), and makes
# the WebGL/WebGPU spoofs moot. Confirmed missing from earlier artifacts by
# the runtime verifier (no GL context / no adapter).
shopt -s nullglob
for lib in "$OUT_DIR"/*.so "$OUT_DIR"/*.so.* "$OUT_DIR"/*_icd.json; do
  TAR_INCLUDES+=("$(basename "$lib")")
done
shopt -u nullglob

echo "[pack] including: ${TAR_INCLUDES[*]}"
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
