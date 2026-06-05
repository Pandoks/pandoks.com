#!/usr/bin/env bash
# apex-chromium: apply the overlay + patches to the Chromium checkout.
#
# Fast and idempotent -- safe to re-run. Does four things:
#   1. drops shared apex headers onto the include path of every module that
#      needs them (including v8/, which is a separate sub-repo);
#   2. installs the whole-function chromium_src overlays (redefine-then-include
#      -- the upstream file is stashed as *.apexorig and the overlay's #include
#      is rewritten to point at it);
#   3. applies the raw .patch files from patches/series (Blink patches into
#      src/, the V8 inspector patch into src/v8/);
#   4. writes the GN args.
set -euo pipefail

APEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${APEX_CHROMIUM_WORK:-$HOME/apex-chromium-build}"
SRC="$WORK/chromium/src"

[ -d "$SRC" ] || { echo "ERROR: no checkout at $SRC -- run scripts/setup.sh first"; exit 1; }

echo "=== apex-chromium apply ==="
echo " checkout: $SRC"

CS="$APEX_ROOT/chromium_src"

# --- 0. shared headers -----------------------------------------------------
# apex_fingerprint.h must be includable as "apex_fingerprint.h" from every TU
# that references it. Drop a copy into each module dir that needs it, plus the
# V8 inspector dir (V8 is a separate sub-repo under src/v8/).
echo "[0/4] installing shared headers ..."
FP_H="$CS/apex_fingerprint.h"
for dir in \
  "third_party/blink/renderer/core/frame" \
  "third_party/blink/renderer/core/execution_context" \
  "third_party/blink/renderer/core/geometry" \
  "third_party/blink/renderer/core/html/canvas" \
  "third_party/blink/renderer/modules/webgl" \
  "third_party/blink/renderer/modules/canvas/canvas2d" \
  "third_party/blink/renderer/modules/webaudio" \
  "third_party/blink/renderer/modules/battery" \
  "third_party/blink/renderer/modules/mediastream" \
  "third_party/blink/renderer/modules/speech" \
  "third_party/blink/renderer/modules/peerconnection" \
  "third_party/blink/renderer/modules/netinfo" \
  "third_party/blink/renderer/modules/quota" \
  "third_party/blink/renderer/modules/font_access" \
  "third_party/blink/renderer/platform/fonts" \
  "third_party/blink/renderer/platform/graphics" \
  "components/embedder_support" \
  "v8/src/inspector" ; do
  mkdir -p "$SRC/$dir"
  cp "$FP_H" "$SRC/$dir/apex_fingerprint.h"
done
# module-local helper headers
cp "$CS/third_party/blink/renderer/modules/webgl/apex_webgl_strings.h" \
   "$SRC/third_party/blink/renderer/modules/webgl/"
cp "$CS/third_party/blink/renderer/modules/canvas/canvas2d/apex_canvas_noise.h" \
   "$SRC/third_party/blink/renderer/modules/canvas/canvas2d/"
cp "$CS/third_party/blink/renderer/core/html/canvas/apex_text_metrics_noise.h" \
   "$SRC/third_party/blink/renderer/core/html/canvas/"
cp "$CS/third_party/blink/renderer/modules/webaudio/apex_audio_noise.h" \
   "$SRC/third_party/blink/renderer/modules/webaudio/"
cp "$CS/third_party/blink/renderer/modules/mediastream/apex_devices.h" \
   "$SRC/third_party/blink/renderer/modules/mediastream/"
cp "$CS/third_party/blink/renderer/modules/speech/apex_voices.h" \
   "$SRC/third_party/blink/renderer/modules/speech/"
cp "$CS/third_party/blink/renderer/platform/fonts/apex_font_policy.h" \
   "$SRC/third_party/blink/renderer/platform/fonts/"

# --- 1. full-file overlays ------------------------------------------------
# navigator_concurrent_hardware + navigator_device_memory are tiny single-
# function files (a verbatim rewrite is simplest there). The other multi-
# function files (screen, battery_manager, navigator_base) stay anchor edits in
# apply_edits.py.
echo "[1/4] installing full-file overlays ..."
OVERLAYS=(
  "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc"
  "third_party/blink/renderer/core/frame/navigator_device_memory.cc"
)
for rel in "${OVERLAYS[@]}"; do
  up="$SRC/$rel"
  ov="$CS/$rel"
  [ -f "$ov" ] || { echo "  MISSING overlay: $ov"; exit 1; }
  [ -f "$up" ] || { echo "  MISSING upstream: $up"; exit 1; }
  if [ ! -f "$up.apexorig" ]; then
    cp "$up" "$up.apexorig"
  fi
  # full-file replacement: the overlay is a complete .cc, copied verbatim.
  cp "$ov" "$up"
  echo "  overlaid  $rel"
done

# --- 2. mid-function edits (anchor-based, version-resilient) ---------------
# The .patch files in patches/ document the changes; apply_edits.py applies
# them by ANCHOR (a unique code substring) rather than by line number, which
# survives Chromium version drift. Covers WebGL, WebRTC, the V8 inspector,
# canvas/audio noise, speech voices, devices, and fonts.
echo "[2/4] applying mid-function edits (anchor-based) ..."
APEX_CHROMIUM_WORK="$WORK" python3 "$APEX_ROOT/scripts/apply_edits.py" || {
  echo "    !! some anchors not found -- Chromium drifted."
  echo "       run: APEX_CHROMIUM_WORK='$WORK' python3 scripts/apply_edits.py --check"
  echo "       then re-fit the failing anchors in apply_edits.py's EDITS list."
  exit 1
}

# --- 3. GN args ------------------------------------------------------------
echo "[3/4] writing GN args ..."
mkdir -p "$SRC/out/apex"
cp "$APEX_ROOT/build/args.gn" "$SRC/out/apex/args.gn"

echo "[4/4] done."
echo
echo "=== apply complete ==="
echo " next: scripts/build.sh"
