#!/usr/bin/env bash
# Deterministic apex-languages check on a clean-egress EC2 box: download the
# newest patched binary, then run lang_probe.py (forces a Spanish identity ->
# APEX_FP_LANGUAGES=es-ES,es,en) and read navigator.languages back. No proxy
# (the patch is IP-independent). Run via the dev-builder SFN with
#   command="bash packages/stealth-chromium/scripts/run-lang-probe.sh"
set -uo pipefail

# Runner (infra/runner/) exports RUNNER_*; map to the legacy names this
# script reads (builder->runner rename).
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
: "${BUILDER_CACHE_BUCKET:=${RUNNER_CACHE_BUCKET:-}}"
export HOME="${HOME:-/root}"
PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/langprobe
mkdir -p "$WORK"
LOG="$WORK/lang-probe.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/lang-probe.log" >/dev/null 2>&1 || true' EXIT

echo "=== deps ==="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq || true
sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 libatspi2.0-0t64 libgtk-3-0t64 libxshmfence1 \
  libglib2.0-0t64 >/dev/null 2>&1 || sudo apt-get install -y -qq xvfb \
  fonts-liberation libnss3 libnspr4 libgbm1 libasound2 >/dev/null 2>&1 || true

echo "=== newest patched binary ==="
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E 'stealth-chromium-149.*/chromium-.*\.tar\.zst$' \
  | sort | tail -1 | awk '{print $NF}')"
echo "  artifact: $TARKEY"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst" --quiet
mkdir -p "$WORK/chrome"
zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
BIN="$WORK/chrome/chrome"
chmod +x "$BIN"

echo "=== uv sync ==="
cd "$REPO_ROOT/packages/stealth-browser"
uv sync >/dev/null 2>&1 || uv sync

export APEX_CHROME_PATH="$BIN" APEX_CORE=nodriver PYTHONUNBUFFERED=1
echo "=== run lang_probe (forced es-ES identity) ==="
xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/lang_probe.py" 2>&1 || true
echo "=== done ==="
