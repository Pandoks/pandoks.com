#!/usr/bin/env bash
# Prove the Android-persona method (CDP mobile emulation) on a clean EC2 box via
# the SFN. Dumps every mobile surface for coherence review.
#   command="bash packages/stealth-chromium/scripts/android_test.sh"
set -uo pipefail
PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/mobileprodtest; mkdir -p "$WORK"
LOG="$WORK/mobile-prod-test.log"; exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/mobile-prod-test.log" >/dev/null 2>&1 || true' EXIT

echo "=== deps ==="
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
    libglib2.0-0 2>/dev/null || echo "  (some deps failed)"

echo "=== download newest 149 binary ==="
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E 'stealth-chromium-149.*/chromium-.*\.tar\.zst$' | sort | tail -1 | awk '{print $NF}')"
[ -n "$TARKEY" ] || { echo "ERROR: no binary"; exit 1; }
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst"
mkdir -p "$WORK/chrome"; zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
export APEX_CHROME_PATH="$WORK/chrome/chrome"; chmod +x "$APEX_CHROME_PATH"
cd "$REPO_ROOT/packages/stealth-browser"; uv sync

echo "=== Mobile production-path probe (Galaxy S23 + Pixel 7) ==="
pkill -x chrome 2>/dev/null; sleep 1
timeout 90 xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/mobile_prod_probe.py" "Galaxy S23" 2>&1 \
  | grep -E 'MOBILE_PROD_RESULT|Error|Traceback' || echo "  (no result)"
echo "=== done ==="
pkill -x chrome 2>/dev/null; sleep 1
timeout 90 xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/mobile_prod_probe.py" "Pixel 7" 2>&1 \
  | grep -E 'MOBILE_PROD_RESULT|persona:|Error|Traceback' || echo "  (pixel no result)"
