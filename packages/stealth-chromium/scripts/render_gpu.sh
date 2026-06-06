#!/usr/bin/env bash
# Render-output investigation on a REAL-GPU box (g4dn) via the dev-builder SFN.
# Installs the NVIDIA driver, then renders one identical deterministic scene
# (render_probe.py) several ways on the SAME box to measure:
#   * hardware (NVIDIA T4) vs llvmpipe vs SwiftShader  -- raw render delta
#   * farbled llvmpipe across seeds                    -- does apex noise make
#     each persona's render unique + move it off the raw software baseline?
# Pass instanceType=g4dn.xlarge to the SFN (an INPUT, not an IaC change). The
# SFN auto-terminates the spot box, so there is no orphan/cost risk.
#   command="bash packages/stealth-chromium/scripts/render_gpu.sh"
set -uo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/rendergpu
mkdir -p "$WORK"
LOG="$WORK/render-gpu.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/render-gpu.log" >/dev/null 2>&1 || true' EXIT

echo "=== [1/4] deps + NVIDIA driver ==="
export DEBIAN_FRONTEND=noninteractive
# wait out the boot-time dpkg lock (same race that bit the build)
sudo systemctl stop unattended-upgrades.service apt-daily.service \
  apt-daily-upgrade.service 2>/dev/null || true
_w=0; while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
  _w=$((_w+1)); [ "$_w" -gt 60 ] && break; sleep 5; done
sudo apt-get update -qq || true
sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 libatspi2.0-0t64 libgtk-3-0t64 libxshmfence1 \
  libglib2.0-0t64 mesa-utils 2>/dev/null || \
  sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libatspi2.0-0 libgtk-3-0 libxshmfence1 \
    libglib2.0-0 mesa-utils 2>/dev/null || echo "  (some deps failed)"
echo "  installing NVIDIA driver (ubuntu-drivers autoinstall) ..."
sudo apt-get install -y -qq ubuntu-drivers-common 2>/dev/null || true
sudo ubuntu-drivers autoinstall 2>&1 | tail -3 || \
  sudo apt-get install -y -qq nvidia-driver-535-server 2>&1 | tail -3 || \
  echo "  (driver install failed -- GPU arm will fall back to software)"
sudo modprobe nvidia 2>/dev/null || true
echo "  nvidia-smi:"; nvidia-smi --query-gpu=name,driver_version --format=csv 2>&1 | head -3 || echo "  (nvidia-smi unavailable)"

echo "=== [2/4] download newest 149 binary ==="
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E 'stealth-chromium-149.*/chromium-.*\.tar\.zst$' \
  | sort | tail -1 | awk '{print $NF}')"
[ -n "$TARKEY" ] || { echo "ERROR: no binary"; exit 1; }
echo "  artifact: $TARKEY"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst"
mkdir -p "$WORK/chrome"; zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
export APEX_CHROME_PATH="$WORK/chrome/chrome"; chmod +x "$APEX_CHROME_PATH"
cd "$REPO_ROOT/packages/stealth-browser"; uv sync

run() { # label  farble  seed  ANGLE_BACKEND  EXTRA_ENV
  pkill -x chrome 2>/dev/null; sleep 1
  APEX_ANGLE_BACKEND="$4" env $5 timeout 80 xvfb-run -a -s "-screen 0 1920x1080x24" \
    uv run python "$PKG_ROOT/scripts/render_probe.py" "$1" "$2" "$3" 2>/dev/null \
    | grep '^RENDER_RESULT' || echo "RENDER_RESULT {\"label\":\"$1\",\"error\":true}"
}

echo "=== [3/4] render comparisons (same scene, same box) ==="
# hardware: force NVIDIA GLX vendor so ANGLE-GL targets the T4 (verify via the
# reported renderer string -- if it still says llvmpipe the GPU didn't engage)
echo "-- hardware (NVIDIA, best-effort) --"
run hw-nvidia  farble0 0 gl "__GLX_VENDOR_LIBRARY_NAME=nvidia __NV_PRIME_RENDER_OFFLOAD=1"
echo "-- software llvmpipe --"
run sw-llvmpipe farble0 0 gl "LIBGL_ALWAYS_SOFTWARE=1"
echo "-- software swiftshader --"
run sw-swiftsh  farble0 0 swiftshader ""
echo "=== [4/4] farbling decorrelation (llvmpipe, 3 seeds) ==="
run farb-seedA farble1 1001 gl "LIBGL_ALWAYS_SOFTWARE=1"
run farb-seedB farble1 2002 gl "LIBGL_ALWAYS_SOFTWARE=1"
run farb-seedC farble1 3003 gl "LIBGL_ALWAYS_SOFTWARE=1"

echo "=== done -> ${S3}/render-gpu.log ==="
