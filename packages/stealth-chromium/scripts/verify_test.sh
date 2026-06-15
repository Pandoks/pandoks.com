#!/usr/bin/env bash
# Run verify_patched_binary.py (headful-on-Xvfb, the production WebGL/WebGPU
# path) against the newest 149 binary on a clean EC2 box, via the dev-builder
# SFN. Validates the WebGPU launch-flag fix end-to-end without a full rebuild:
# the binary is unchanged (only runtime flags + the verifier's WebGPU assertion
# changed), so a standalone verifier run is the cheap, sufficient test.
#   command="bash packages/stealth-chromium/scripts/verify_test.sh"
set -uo pipefail

# Runner (infra/runner/) exports RUNNER_*; map to the legacy names this
# script reads (builder->runner rename).
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
: "${BUILDER_CACHE_BUCKET:=${RUNNER_CACHE_BUCKET:-}}"

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/verifytest
mkdir -p "$WORK"
LOG="$WORK/verify-test.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/verify-test.log" >/dev/null 2>&1 || true' EXIT

echo "=== [1/3] deps ==="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq || true
sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 libatspi2.0-0t64 libgtk-3-0t64 libxshmfence1 \
  libglib2.0-0t64 2>/dev/null || \
  sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libatspi2.0-0 libgtk-3-0 libxshmfence1 \
    libglib2.0-0 2>/dev/null || echo "  (some deps failed; launch will tell)"

echo "=== [2/3] download newest 149 binary ==="
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E 'stealth-chromium-149.*/chromium-.*\.tar\.zst$' \
  | sort | tail -1 | awk '{print $NF}')"
[ -n "$TARKEY" ] || { echo "ERROR: no binary"; exit 1; }
echo "  artifact: $TARKEY"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst"
mkdir -p "$WORK/chrome"; zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
export APEX_CHROME_PATH="$WORK/chrome/chrome"; chmod +x "$APEX_CHROME_PATH"
cd "$REPO_ROOT/packages/stealth-browser"; uv sync

echo "=== [3/3] verify_patched_binary (headful Xvfb, with WebGPU flags) ==="
pkill -x chrome 2>/dev/null; sleep 1
timeout 360 xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/verify_patched_binary.py" 2>&1 \
  || echo "  (verifier exited non-zero -- see assertions above)"

echo "=== done -> ${S3}/verify-test.log ==="
