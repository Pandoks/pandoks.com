#!/usr/bin/env bash
# Cross-persona coherence audit on a clean EC2 box (no proxy). Installs the
# Windows + Android + macOS-substitute font sets, then runs coherence_probe.py
# over desktop/laptop/Mac/Android personas to verify battery / touch / platform
# / fonts-per-OS coherence. Run via the dev-builder SFN:
#   command="bash packages/stealth-chromium/scripts/run-coherence.sh"
set -uo pipefail
export HOME="${HOME:-/root}"
PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/coherence
mkdir -p "$WORK"
LOG="$WORK/coherence.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/coherence.log" >/dev/null 2>&1 || true' EXIT

echo "=== deps + per-OS fonts ==="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq || true
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
  | sudo debconf-set-selections 2>/dev/null || true
# Windows set (msttcore + metric clones), Android set (Roboto/Noto), macOS
# substitutes (TeX Gyre Heros~Helvetica, Termes~Times, Cursor~Courier).
sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 libatspi2.0-0t64 libgtk-3-0t64 libxshmfence1 \
  libglib2.0-0t64 ttf-mscorefonts-installer fonts-crosextra-carlito \
  fonts-crosextra-caladea fonts-roboto fonts-noto-core fonts-droid-fallback \
  fonts-texgyre >/dev/null 2>&1 \
  || sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 libgbm1 \
       libasound2 fonts-roboto fonts-noto-core >/dev/null 2>&1 || true
sudo fc-cache -f >/dev/null 2>&1 || true
echo "  fonts visible: $(fc-list 2>/dev/null | wc -l)"

echo "=== newest patched binary ==="
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E 'stealth-chromium-149.*/chromium-.*\.tar\.zst$' \
  | sort | tail -1 | awk '{print $NF}')"
echo "  artifact: $TARKEY"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst" --quiet
mkdir -p "$WORK/chrome"
zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
BIN="$WORK/chrome/chrome"; chmod +x "$BIN"

echo "=== uv sync ==="
cd "$REPO_ROOT/packages/stealth-browser"
uv sync >/dev/null 2>&1 || uv sync

export APEX_CHROME_PATH="$BIN" APEX_CORE=nodriver PYTHONUNBUFFERED=1
echo "=== coherence audit ==="
xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/coherence_probe.py" 2>&1 || true
echo "=== done ==="
