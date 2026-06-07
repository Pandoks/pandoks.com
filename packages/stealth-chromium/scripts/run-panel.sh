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

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # packages/stealth-chromium
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"                   # repo root (two up)
WORK=/tmp/panel
mkdir -p "$WORK"
# Unbuffered Python so per-target progress is visible live in panel-run.log
# (peekable mid-run via a second SSM command) instead of stuck in a block buffer
# until the process exits. Cheap; applies to the verifier + the benchmark below.
export PYTHONUNBUFFERED=1

# Self-diagnosing: capture ALL output and upload it on ANY exit (success or
# failure). A failed SFN command leaves no retrievable stdout (SSM truncates,
# the instance is terminated), so without this the failure point is invisible.
LOG="$WORK/panel-run.log"
exec > >(tee "$LOG") 2>&1
_upload_log() {
  [ -n "${BUILDER_ARTIFACTS_BUCKET:-}" ] && \
    aws s3 cp "$LOG" \
      "s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}/panel-run.log" \
      >/dev/null 2>&1 || true
}
trap _upload_log EXIT

echo "=== [1/5] runtime deps (Chromium libs + Xvfb + base fonts) ==="
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq || true
# Windows-persona FONT REALISM: CreepJS (and others) measure font WIDTHS to
# detect which fonts are installed. A Linux box has Liberation/DejaVu, NOT the
# Windows web-safe set the persona claims -> only ~6/51 common fonts match, a
# "like headless"/anomalous-platform signal. Fix with the real MS core fonts
# PLUS free METRIC-COMPATIBLE substitutes: Carlito has Calibri's exact metrics,
# Caladea has Cambria's -- so a width-based test sees the persona's fonts as
# present. (The proprietary originals can't be installed; metric clones are how
# stealth browsers solve this. For production this belongs in the per-persona
# image, not just the panel box.)
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
  | sudo debconf-set-selections 2>/dev/null || true
sudo apt-get install -y -qq \
  ttf-mscorefonts-installer fonts-crosextra-carlito fonts-crosextra-caladea \
  2>/dev/null || true
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

# Rebuild the fontconfig cache so Chrome SEES the fonts installed above. Without
# this the new fonts are on disk but not in the cache Chrome reads at launch, so
# a width-based font test (CreepJS) still misses them. fontconfig's bundled
# 30-metric-aliases.conf maps Calibri->Carlito, Cambria->Caladea, Arial->
# Liberation Sans etc., so name-based font requests resolve to the metric
# clones once the cache is fresh.
sudo fc-cache -f >/dev/null 2>&1 || true
echo "  fonts visible to fontconfig: $(fc-list 2>/dev/null | wc -l)"
# per-OS font sets: core_nodriver points FONTCONFIG_FILE at the persona's OS set
# so the font fingerprint matches the claimed OS (a Mac persona won't show
# Calibri). Built into /opt/apex-fonts/{windows,macos,android}.
bash "$PKG_ROOT/scripts/setup-fonts.sh" || echo "  (setup-fonts warn)"
for f in Calibri Cambria Arial "Times New Roman" Verdana Georgia "Segoe UI" Consolas Tahoma; do
  printf '    %-16s %s\n' "$f" "$(fc-match "$f" 2>/dev/null)"
done

echo "=== [2/5] download latest patched binary from S3 ==="
# Pick the NEWEST tarball by DATE -- `aws s3 ls --recursive` prefixes each line
# with `YYYY-MM-DD HH:MM:SS`, so a plain sort is chronological. (A sort over
# the prefix NAMES would be lexical and wrongly pick e.g. 149selfcheck over the
# newer 149audio.)
TARKEY="$(aws s3 ls --recursive "s3://${BUILDER_ARTIFACTS_BUCKET}/" \
  | grep -E 'stealth-chromium-149.*/chromium-.*\.tar\.zst$' \
  | sort | tail -1 | awk '{print $NF}')"
[ -n "$TARKEY" ] || { echo "ERROR: no stealth-chromium-149* tarball found"; exit 1; }
echo "  artifact: $TARKEY"
aws s3 cp "s3://${BUILDER_ARTIFACTS_BUCKET}/${TARKEY}" "$WORK/c.tar.zst"
mkdir -p "$WORK/chrome"
zstd -d --long=27 -c "$WORK/c.tar.zst" | tar -x -C "$WORK/chrome"
BIN="$WORK/chrome/chrome"
chmod +x "$BIN"
echo "  binary: $BIN ($(du -h "$BIN" | cut -f1))"
ldd "$BIN" 2>&1 | grep -i 'not found' && echo "  WARNING: missing shared libs above" || echo "  ldd: all libs resolved"

echo "=== [3/5] uv sync (nodriver / patchright) ==="
cd "$REPO_ROOT/packages/stealth-browser"
uv sync

export APEX_CHROME_PATH="$BIN" APEX_CORE=nodriver
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}/panel"

echo "=== [4a/5] binary self-check (headful, explicit surfaces) ==="
# Surface-by-surface confirmation on THIS instance (UA OS-coherence, WebGL
# caps 16384 via Mesa llvmpipe, canvas/audio/toBlob farbling, zero toString
# tampering) before the external panel -- so the run carries both the
# market verdicts AND a precise spoof report. Non-fatal.
timeout 300 xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/verify_patched_binary.py" 2>&1 \
  | tee "$WORK/verifier.txt" || true
aws s3 cp "$WORK/verifier.txt" "${S3}/verifier.txt" >/dev/null 2>&1 || true

echo "=== [4b/5] run panel (headful on Xvfb) ==="
# Full panel; per-site errors don't abort (the script catches them).
xvfb-run -a -s "-screen 0 1920x1080x24" \
  uv run python "$PKG_ROOT/scripts/fingerprint_benchmark.py" 2>&1 \
  | tee "$WORK/panel-output.txt" || true

echo "=== [5/5] upload results ==="
aws s3 cp "$WORK/panel-output.txt" "${S3}/panel-output.txt" || true
if [ -d /tmp/fpbench ]; then
  aws s3 cp /tmp/fpbench/ "${S3}/" --recursive || true
fi
echo "=== run-panel done -> ${S3}/ ==="
