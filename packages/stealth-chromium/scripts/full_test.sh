#!/usr/bin/env bash
# Clean-egress EC2 test pass: (1) runtime-verify EVERY fp_profile is coherent,
# (2) investigate behavioral bot detection (do our ghost-cursor CDP mouse
# events register + move a behavioral score?). Driven by the dev-builder SFN:
#   command="bash packages/stealth-chromium/scripts/full_test.sh"
# The local Claude container's chrome launch is too flaky for many sequential
# browsers; a clean EC2 box handles them. Results upload to the artifact prefix.
set -uo pipefail

# Runner (infra/runner/) exports RUNNER_*; map to the legacy names this
# script reads (builder->runner rename).
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
: "${BUILDER_CACHE_BUCKET:=${RUNNER_CACHE_BUCKET:-}}"

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
WORK=/tmp/fulltest
mkdir -p "$WORK"
LOG="$WORK/full-test.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/full-test.log" >/dev/null 2>&1 || true' EXIT

echo "=== [1/4] deps ==="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq || true
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
  | sudo debconf-set-selections 2>/dev/null || true
sudo apt-get install -y -qq xvfb fonts-liberation fonts-dejavu-core fonts-noto-core \
  ttf-mscorefonts-installer fonts-crosextra-carlito fonts-crosextra-caladea \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2t64 libpango-1.0-0 libcairo2 libatspi2.0-0t64 libgtk-3-0t64 \
  libxshmfence1 libglib2.0-0t64 2>/dev/null || \
  sudo apt-get install -y -qq xvfb fonts-liberation libnss3 libnspr4 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libatspi2.0-0 libgtk-3-0 libxshmfence1 \
    libglib2.0-0 2>/dev/null || echo "  (some deps failed; launch will tell)"
sudo fc-cache -f >/dev/null 2>&1 || true

echo "=== [2/4] download latest patched binary ==="
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E 'stealth-chromium-149.*/chromium-.*\.tar\.zst$' \
  | sort | tail -1 | awk '{print $NF}')"
[ -n "$TARKEY" ] || { echo "ERROR: no binary"; exit 1; }
echo "  artifact: $TARKEY"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst"
mkdir -p "$WORK/chrome"; zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
export APEX_CHROME_PATH="$WORK/chrome/chrome"; chmod +x "$APEX_CHROME_PATH"
cd "$REPO_ROOT/packages/stealth-browser"; uv sync

echo "=== [3/4] runtime-verify EVERY profile (one browser per process) ==="
N=$(uv run python -c "from stealth_browser.fp_profiles import PROFILES; print(len(PROFILES))")
echo "  profile count: $N"
PASS=0; TOTAL=0
for i in $(seq 0 $((N - 1))); do
  TOTAL=$((TOTAL + 1))
  out=""
  for try in 1 2 3 4; do
    pkill -x chrome 2>/dev/null; sleep 1
    out=$(timeout 70 xvfb-run -a -s "-screen 0 1920x1080x24" \
      uv run python "$PKG_ROOT/scripts/profile_probe.py" "$i" 2>/dev/null | grep '^RESULT')
    [ -n "$out" ] && break
  done
  if [ -n "$out" ]; then
    echo "  ${out#RESULT }"
    echo "$out" | grep -q '\[PASS\]' && PASS=$((PASS + 1))
  else
    echo "  [SKIP] profile $i (launch failed x4)"
  fi
done
echo "  PROFILES: $PASS/$TOTAL coherent"

echo "=== [4/4] behavioral investigation (incolumitas + ghost cursor) ==="
pkill -x chrome 2>/dev/null; sleep 1
timeout 90 xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/behavior_probe.py" 2>&1 \
  | grep -E 'BEHAVIOR_RESULT|install counter' || echo "  (behavior probe produced no result)"

echo "=== done -> ${S3}/full-test.log ==="
