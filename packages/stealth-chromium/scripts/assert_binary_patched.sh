#!/usr/bin/env bash
# Assert the freshly-built Chromium binary actually CONTAINS the fingerprint
# patches -- not just that it compiled. Each env-var-gated patch reads a unique
# APEX_FP_* string via std::getenv; that string literal lands in .rodata and
# survives stripping, so `strings | grep` is a reliable "is the patch linked
# in?" probe. A patch can silently drop out of a build (apply skip, stale
# ccache object, header misplacement) while the build still SUCCEEDS -- this
# script is the guard that turns that into a loud failure instead of a
# fingerprint that quietly de-cloaks at runtime.
#
# Run by sfn-build.sh after build.sh, before packaging. Exits non-zero (which
# trips sfn-build.sh's ERR trap -> diagnostics uploaded, no artifact) if any
# expected patch string is missing.
set -euo pipefail

WORK="${APEX_CHROMIUM_WORK:-$HOME/apex-chromium-build}"
SRC="$WORK/chromium/src"
case "$(uname -s)" in
  Darwin) BIN="${1:-$SRC/out/apex/Chromium.app/Contents/MacOS/Chromium}" ;;
  *) BIN="${1:-$SRC/out/apex/chrome}" ;;
esac
[ -x "$BIN" ] || {
  echo "ERROR: binary not found at $BIN"
  exit 1
}

echo "=== asserting patches are linked into $BIN ==="

# Every env-var-gated patch must contribute its APEX_FP_* literal. One per
# patched surface/file -- a whole file's patch dropping out removes its
# string. (Active()/Seed()-only patches -- canvas/audio/webrtc/cdp/voices/
# devices/fonts -- have no unique literal and are covered by the runtime
# verify_patched_binary.py harness instead.)
REQUIRED=(
  APEX_FP_ACTIVE
  APEX_FP_SEED
  APEX_FP_PLATFORM
  APEX_FP_UA_PLATFORM
  APEX_FP_UA_PLATFORM_VERSION
  APEX_FP_HW_CONCURRENCY
  APEX_FP_DEVICE_MEMORY
  APEX_FP_WEBGL_VENDOR
  APEX_FP_WEBGL_RENDERER
  APEX_FP_SCREEN_W
  APEX_FP_SCREEN_H
  APEX_FP_SCREEN_AVAIL_W
  APEX_FP_SCREEN_AVAIL_H
  APEX_FP_COLOR_DEPTH
  APEX_FP_BATTERY_LEVEL
  APEX_FP_BATTERY_CHARGING
  APEX_FP_NET_RTT
  APEX_FP_NET_DOWNLINK
  APEX_FP_NET_EFFECTIVE_TYPE
  APEX_FP_STORAGE_QUOTA
)

# One strings pass, cached to a temp file (the binary is ~500 MB).
STRTMP="$(mktemp)"
trap 'rm -f "$STRTMP"' EXIT
strings -a "$BIN" > "$STRTMP"

missing=0
for s in "${REQUIRED[@]}"; do
  if grep -qx "$s" "$STRTMP"; then
    echo "  OK   $s"
  else
    echo "  MISSING  $s"
    missing=$((missing + 1))
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "ERROR: $missing expected patch string(s) absent from the binary --"
  echo "       a patch silently dropped out (apply skip / stale ccache /"
  echo "       header misplacement). Refusing to ship a half-patched binary."
  exit 1
fi
echo "=== all $((${#REQUIRED[@]})) env-var-gated patches present in the binary ==="
