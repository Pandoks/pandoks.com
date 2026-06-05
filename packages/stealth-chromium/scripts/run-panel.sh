#!/usr/bin/env bash
# Run the live fingerprinter panel against the latest patched binary on a
# CLEAN-EGRESS EC2 instance. The Claude sandbox MITMs browser TLS/QUIC (Chrome
# rejects the certs), so the panel -- which loads real detector sites
# (CreepJS, sannysoft, browserleaks, ...) -- cannot run there. A normal EC2
# instance has clean egress, so we run it via the dev-builder SFN with
#   command="bash packages/stealth-chromium/scripts/run-panel.sh"
# on a SMALL spot instance (single browser, low CPU). The SFN clones the repo,
# exports BUILD_ID + BUILDER_ARTIFACTS_BUCKET, and terminates the box after.
#
# NOTE: a GPU-less instance renders WebGL via SwiftShader (MAX_TEXTURE_SIZE
# 8192), so WebGL caps won't match the persona's claimed GPU -- expect WebGL
# findings. Everything else (TLS/JA3, headless detection, canvas/audio/
# navigator coherence) is a faithful real-world test. Results + screenshots
# upload to s3://$BUILDER_ARTIFACTS_BUCKET/$BUILD_ID/panel/.
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/.." && pwd)"
WORK=/tmp/panel
mkdir -p "$WORK"

echo "=== [1/5] runtime deps (Chromium libs + Xvfb + base fonts) ==="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq || true
# Non-fatal: if a lib name drifted across Ubuntu releases, the actual chrome
# launch is the real test. t64 names are noble (24.04); fall back to classic.
sudo apt-get install -y -qq \
  xvfb fonts-liberation fonts-dejavu-core fonts-noto-core \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2t64 libpango-1.0-0 libcairo2 libatspi2.0-0t64 libgtk-3-0t64 \
  libxshmfence1 libglib2.0-0t64 2>/dev/null \
  || sudo apt-get install -y -qq \
       xvfb fonts-liberation libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
       libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
       libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 \
       libgtk-3-0 libxshmfence1 libglib2.0-0 \
  || echo "  (some deps failed to install -- continuing; launch will tell)"

echo "=== [2/5] download latest patched binary from S3 ==="
KEY="$(aws s3 ls "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | awk '{print $NF}' | grep '^stealth-chromium-149' | sort | tail -1)"
KEY="${KEY%/}"
[ -n "$KEY" ] || { echo "ERROR: no stealth-chromium-149* artifact found"; exit 1; }
echo "  artifact build: $KEY"
TARBALL="$(aws s3 ls "s3://${BUILDER_ARTIFACTS_BUCKET}/${KEY}/" \
  | awk '{print $NF}' | grep '\.tar\.zst$' | head -1)"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${KEY}/${TARBALL}" "$WORK/c.tar.zst"
mkdir -p "$WORK/chrome"
zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
BIN="$WORK/chrome/chrome"
chmod +x "$BIN"
echo "  binary: $BIN"

echo "=== [3/5] uv sync (nodriver / patchright) ==="
cd "$REPO_ROOT/packages/stealth-browser"
uv sync

echo "=== [4/5] run panel (headful on Xvfb) ==="
export APEX_CHROME_PATH="$BIN" APEX_CORE=nodriver
# Full panel; per-site errors don't abort (the script catches them).
xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/fingerprint_benchmark.py" 2>&1 \
  | tee "$WORK/panel-output.txt" || true

echo "=== [5/5] upload results ==="
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}/panel"
aws s3 cp "$WORK/panel-output.txt" "${S3}/panel-output.txt" || true
if [ -d /tmp/fpbench ]; then
  aws s3 cp /tmp/fpbench/ "${S3}/" --recursive || true
fi
echo "=== run-panel done -> ${S3}/ ==="
