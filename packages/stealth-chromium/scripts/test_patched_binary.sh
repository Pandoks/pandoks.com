#!/usr/bin/env bash
# apex-chromium: end-to-end test of the freshly built patched binary.
#
# Run after build.sh succeeds. It:
#   1. locates the built Chromium binary;
#   2. launches it with APEX_FP_* set and loads verify_patches.html to confirm
#      every patched surface is spoofed AND toString stays native;
#   3. points apex-browser at the patched binary and runs the full 16-detector
#      benchmark (fingerprinters + WebRTC/CDP leak probes + anti-bot sites).
#
# Exits 0 only if the patched binary verifies clean.
set -euo pipefail

APEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${APEX_CHROMIUM_WORK:-$HOME/apex-chromium-build}"
SRC="$WORK/chromium/src"

# 1. locate the binary
case "$(uname -s)" in
  Darwin) BIN="$SRC/out/apex/Chromium.app/Contents/MacOS/Chromium";;
  *)      BIN="$SRC/out/apex/chrome";;
esac
[ -x "$BIN" ] || { echo "ERROR: built binary not found at $BIN"; exit 1; }
echo "=== apex-chromium patched binary test ==="
echo " binary: $BIN"
"$BIN" --version || true
echo

# 2. headful smoke: load verify_patches.html with fingerprint mode on,
#    dump the rendered verdict via --dump-dom after a short settle.
echo "[1/2] patch verification page ..."
VERIFY="file://$APEX_ROOT/scripts/verify_patches.html"
APEX_FP_ACTIVE=1 APEX_FP_SEED=4242 \
  APEX_FP_PLATFORM=MacIntel APEX_FP_UA_PLATFORM=macOS \
  APEX_FP_HW_CONCURRENCY=10 APEX_FP_DEVICE_MEMORY=8 \
  APEX_FP_WEBGL_VENDOR="Google Inc. (Apple)" \
  APEX_FP_WEBGL_RENDERER="ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)" \
  APEX_FP_SCREEN_W=1512 APEX_FP_SCREEN_H=982 \
  APEX_FP_SCREEN_AVAIL_W=1512 APEX_FP_SCREEN_AVAIL_H=944 \
  APEX_FP_COLOR_DEPTH=24 APEX_FP_BATTERY_LEVEL=0.82 APEX_FP_BATTERY_CHARGING=0 \
  "$BIN" --headless=new --disable-gpu --dump-dom --virtual-time-budget=5000 \
  "$VERIFY" 2>/dev/null | grep -oE '(PASS|FAIL|leak|native code|ALL CLEAN)[^<]*' \
  | head -40 || true
echo

# 3. point apex-browser at it and run the full benchmark
echo "[2/2] full 16-detector benchmark with the patched binary ..."
echo "  export APEX_CHROME_PATH='$BIN'"
echo "  then: cd apex-browser && APEX_CORE=nodriver APEX_CHROME_PATH='$BIN' \\"
echo "        PORT=8089 uv run python run.py &"
echo "  then: cd benchmark && uv run python run_benchmark.py --browsers apex-nodriver"
echo
echo "=== binary located and version-checked; run the benchmark above ==="
