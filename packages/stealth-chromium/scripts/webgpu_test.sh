#!/usr/bin/env bash
# Discover (on a clean EC2 box, via the dev-builder SFN) which launch-flag combo
# gives WebGPU a software adapter on a GPU-less host -- without knocking WebGL
# off llvmpipe. No rebuild: tests the already-bundled SwiftShader Vulkan ICD +
# apex-webgpu-adapterinfo patch in the newest 149 binary.
#   command="bash packages/stealth-chromium/scripts/webgpu_test.sh"
set -uo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/webgputest
mkdir -p "$WORK"
LOG="$WORK/webgpu-test.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/webgpu-test.log" >/dev/null 2>&1 || true' EXIT

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
echo "  bundled Vulkan ICD present?"; ls -la "$WORK/chrome"/vk_*icd.json "$WORK/chrome"/libvk_swiftshader.so "$WORK/chrome"/libvulkan.so* 2>&1 || true
cd "$REPO_ROOT/packages/stealth-browser"; uv sync

echo "=== [3/3] WebGPU flag-combo discovery (one browser/process) ==="
N=$(uv run python -c "from sys import path; path.insert(0,'$PKG_ROOT/scripts'); from webgpu_probe import COMBOS; print(len(COMBOS))")
echo "  combos: $N"
for i in $(seq 0 $((N - 1))); do
  out=""
  for try in 1 2 3; do
    pkill -x chrome 2>/dev/null; sleep 1
    out=$(timeout 80 xvfb-run -a -s "-screen 0 1920x1080x24" \
      uv run python "$PKG_ROOT/scripts/webgpu_probe.py" "$i" 2>/dev/null | grep '^WGPU')
    [ -n "$out" ] && break
  done
  [ -n "$out" ] && echo "  ${out#WGPU }" || echo "  [SKIP] combo $i (launch failed x3)"
done

echo "=== done -> ${S3}/webgpu-test.log ==="
