#!/usr/bin/env bash
# apex-chromium: verify the patch set still applies to the current Chromium.
#
# This is the ~4-week treadmill. When Chromium ships a new major:
#   1. bump chromium_version.txt
#   2. re-run setup.sh (checks out the new tag, syncs deps)
#   3. run THIS script -- it dry-run-checks every anchor and every overlay.
#
# The 5 whole-function OVERLAYS (chromium_src/*.cc) usually need NO work across
# versions -- they redefine-then-include the upstream file, so as long as the
# method name and signature are unchanged the overlay still compiles.
#
# The mid-function EDITS (apply_edits.py) are anchor-based: each finds a unique
# code substring. An anchor only breaks if Chromium renames/removes that exact
# code -- far more resilient than line-numbered patches. When one breaks, open
# the named source file, find where the code moved, and update the `anchor`
# string in scripts/apply_edits.py's EDITS list.
set -euo pipefail

APEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${APEX_CHROMIUM_WORK:-$HOME/apex-chromium-build}"
SRC="$WORK/chromium/src"

[ -d "$SRC" ] || { echo "ERROR: no checkout -- run setup.sh first"; exit 1; }

echo "=== apex-chromium refresh-check ==="
echo " Chromium: $(cat "$APEX_ROOT/chromium_version.txt")"
echo

# 1. overlays -- check each upstream target file still exists
echo "[1/2] checking whole-function overlay targets ..."
OVERLAYS=(
  "third_party/blink/renderer/core/frame/navigator_id.cc"
  "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc"
  "third_party/blink/renderer/core/frame/navigator_device_memory.cc"
  "third_party/blink/renderer/core/frame/screen.cc"
  "third_party/blink/renderer/modules/battery/battery_manager.cc"
)
ov_fail=0
for rel in "${OVERLAYS[@]}"; do
  if [ -f "$SRC/$rel" ]; then
    echo "  OK    $rel"
  else
    echo "  GONE  $rel -- upstream file moved/removed"
    ov_fail=$((ov_fail + 1))
  fi
done

# 2. mid-function edits -- dry-run anchor check
echo
echo "[2/2] checking mid-function edit anchors ..."
if APEX_CHROMIUM_WORK="$WORK" python3 "$APEX_ROOT/scripts/apply_edits.py" --check; then
  edit_fail=0
else
  edit_fail=1
fi

echo
if [ "$ov_fail" -eq 0 ] && [ "$edit_fail" -eq 0 ]; then
  echo "All patches/overlays apply cleanly -- no refresh needed."
else
  echo "Refresh needed: re-fit the items flagged above before building."
  exit 1
fi
