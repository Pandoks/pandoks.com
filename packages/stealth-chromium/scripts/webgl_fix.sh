#!/usr/bin/env bash
# Test GPU-stability flag sets against the in-session WebGL death, on a clean
# EC2 box via the SFN. Loops webgl_fix.py modes (one browser per process).
#   command="bash packages/stealth-chromium/scripts/webgl_fix.sh"
set -uo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/webglfix
mkdir -p "$WORK"
LOG="$WORK/webgl-fix.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/webgl-fix.log" >/dev/null 2>&1 || true' EXIT

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

echo "=== [3/3] WebGL stability test (panel-faithful, one browser/process) ==="
export STEALTH_IN_DOCKER=1
run() { # label  APEX_SHOT  APEX_EXTRA_FLAGS
  echo "--- $1 ---"
  local out=""
  for try in 1 2; do
    pkill -x chrome 2>/dev/null; sleep 1
    out=$(APEX_SHOT="$2" APEX_EXTRA_FLAGS="$3" timeout 170 \
      xvfb-run -a -s "-screen 0 1920x1080x24" \
      uv run python "$PKG_ROOT/scripts/webgl_fix.py" "$1" 2>&1 \
      | grep -E 'WEBGL-|FIX \[|NAV-FAIL|warn')
    echo "$out" | grep -q 'FIX \[' && break
  done
  echo "$out"
}
# A: panel-faithful (screenshots) -- expected to REPRODUCE the death
run "A-shot-control"        1 ""
# B: same but NO screenshots -- isolate screenshot() as the trigger
run "B-noshot-control"      0 ""
# C: screenshots + GPU stability flags -- the candidate FIX
run "C-shot-watchdog+limit" 1 "--disable-gpu-watchdog --disable-gpu-process-crash-limit"
# D: screenshots + just the watchdog flag (minimal fix)
run "D-shot-watchdog-only"  1 "--disable-gpu-watchdog"

echo "=== done -> ${S3}/webgl-fix.log ==="
