#!/usr/bin/env bash
# Run the acceptance probe (network gate + enterprise targets + storage
# isolation) against the latest patched binary, THROUGH the Oxylabs residential
# proxy, on a clean-egress EC2 instance via the dev-runner SFN.
#
# The Claude sandbox MITMs browser TLS, so the network gate (which must observe
# Chrome's UNTOUCHED handshake exiting the proxy) cannot run there -- a normal
# EC2 box has clean egress. Creds + hosts arrive as plaintext env vars in the
# SFN command (the boxes are private + ephemeral; owner-approved), e.g.
#   command="export OXYLABS_USERNAME='...'; export OXYLABS_PASSWORD='...'; \
#     export OXYLABS_PROXIES='h1.hbproxy.net,...'; export APEX_PROFILE_GROUP=intel; \
#     bash packages/stealth-chromium/scripts/acceptance-test.sh"
set -euo pipefail
export HOME="${HOME:-/root}"

# Runner exports RUNNER_*; map to the legacy names this script reads.
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
export BUILDER_ARTIFACTS_BUCKET BUILD_ID

# proxy.py reads OXYLABS_PROXIES; accept the longer alias too.
export OXYLABS_USERNAME="${OXYLABS_USERNAME:-}"
export OXYLABS_PASSWORD="${OXYLABS_PASSWORD:-}"
export OXYLABS_PROXIES="${OXYLABS_PROXIES:-${OXYLABS_RESIDENTIAL_PROXIES:-}}"

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/acceptance
mkdir -p "$WORK"
export PYTHONUNBUFFERED=1
LOG="$WORK/acceptance-run.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}/acceptance"
trap 'aws s3 cp "$LOG" "${S3}/acceptance-run.log" >/dev/null 2>&1 || true' EXIT

echo "=== proxy env: user_len=${#OXYLABS_USERNAME} pass_len=${#OXYLABS_PASSWORD} hosts=$(printf '%s' "$OXYLABS_PROXIES" | tr ',' '\n' | grep -c .) ==="
if [ -z "$OXYLABS_USERNAME" ] || [ -z "$OXYLABS_PASSWORD" ] || [ -z "$OXYLABS_PROXIES" ]; then
  echo "ERROR: oxylabs creds/hosts unavailable -- aborting acceptance run"
  exit 1
fi

echo "=== [1/4] runtime deps (Chromium libs + Xvfb + fonts) ==="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq || true
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
  | sudo debconf-set-selections 2>/dev/null || true
sudo apt-get install -y -qq \
  ttf-mscorefonts-installer fonts-crosextra-carlito fonts-crosextra-caladea \
  2>/dev/null || true
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
  || echo "  (some deps failed -- continuing; launch will tell)"
sudo fc-cache -f >/dev/null 2>&1 || true
bash "$PKG_ROOT/scripts/setup-fonts.sh" || echo "  (setup-fonts warn)"

echo "=== [2/4] download latest patched binary from S3 ==="
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E '/chromium-149.*\.tar\.zst$' \
  | sort | tail -1 | awk '{print $NF}')"
[ -n "$TARKEY" ] || { echo "ERROR: no chromium-149* tarball found"; exit 1; }
echo "  artifact: $TARKEY"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst"
mkdir -p "$WORK/chrome"
zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
BIN="$WORK/chrome/chrome"
chmod +x "$BIN"
echo "  binary: $BIN ($(du -h "$BIN" | cut -f1))"

echo "=== [3/4] uv sync (nodriver) ==="
cd "$REPO_ROOT/packages/stealth-browser"
uv sync

export APEX_CHROME_PATH="$BIN" APEX_CORE=nodriver

echo "=== [4/4] run acceptance probe (headful on Xvfb, via proxy) ==="
xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/acceptance_probe.py" "${1:-all}" 2>&1 \
  | tee "$WORK/acceptance-output.txt" || true

echo "=== upload results ==="
aws s3 cp "$WORK/acceptance-output.txt" "${S3}/acceptance-output.txt" || true
[ -f "$WORK/acceptance.json" ] && aws s3 cp "$WORK/acceptance.json" "${S3}/acceptance.json" || true
for png in "$WORK"/*.png; do
  [ -f "$png" ] && aws s3 cp "$png" "${S3}/$(basename "$png")" || true
done
echo "=== acceptance-test done -> ${S3}/ ==="
