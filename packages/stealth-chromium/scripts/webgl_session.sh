#!/usr/bin/env bash
# Reproduce + localise the in-session WebGL death via the real NodriverCore,
# on a clean EC2 box (clean egress for the real sites) through the SFN.
#   command="bash packages/stealth-chromium/scripts/webgl_session.sh"
set -uo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/webglsession
mkdir -p "$WORK"
LOG="$WORK/webgl-session.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/webgl-session.log" >/dev/null 2>&1 || true' EXIT

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
export STEALTH_IN_DOCKER=1
echo "  llvmpipe driver present?"; ls /usr/lib/x86_64-linux-gnu/dri/*.so 2>&1 | head || true
echo "  vulkan ICDs?"; ls /usr/share/vulkan/icd.d/ 2>&1 || echo "  (none)"
cd "$REPO_ROOT/packages/stealth-browser"; uv sync

echo "=== [3/3] in-session WebGL probe (real NodriverCore) ==="
pkill -x chrome 2>/dev/null; sleep 1
timeout 180 xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/webgl_session.py" 2>&1 \
  | grep -E 'WEBGL-|Error|Traceback' || echo "  (no result)"

echo "=== done -> ${S3}/webgl-session.log ==="
