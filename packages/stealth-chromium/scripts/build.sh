#!/usr/bin/env bash
# apex-chromium: compile the patched Chromium.
#
# Run AFTER setup.sh (checkout) and apply.sh (overlay+patches). This is the
# multi-hour step -- 5-10h for a first build, minutes for incremental rebuilds.
set -euo pipefail

APEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${APEX_CHROMIUM_WORK:-$HOME/apex-chromium-build}"
SRC="$WORK/chromium/src"
export PATH="$WORK/depot_tools:$PATH"

[ -d "$SRC/out/apex" ] || { echo "ERROR: run scripts/apply.sh first"; exit 1; }

cd "$SRC"

# ccache configuration. We disabled `-fmodules` (Clang header modules) in
# args.gn via `use_clang_modules = false`, which removes the only flag that
# was making compiles uncacheable. Without -fmodules in cflags, ccache can
# hash every compile normally.
#
# Empirical history that led here:
#   - Build 103425 first populated ccache (119.7 MiB).
#   - Build 140538 (warm test) revealed 88.17% of calls were "uncacheable"
#     because -fmodules was in the compile flags. ccache's strict bypass.
#   - Build 142930 tested CCACHE_SLOPPINESS=modules — no effect.
#     sccache also bypasses -fmodules (per mozilla/sccache README).
#   - Verified via Chromium's build/config/compiler/BUILD.gn: -fmodules is
#     only emitted when use_clang_modules is true. Setting it false drops
#     the flag entirely. Trade-off: slightly slower cold builds (modules
#     accelerate header parsing), but warm builds become genuinely cached.
#
# Cache-key versioning so the no-modules-build cache doesn't collide with
# the prior modules-build entries (different compile flags = different
# hashes anyway, but key-prefixing makes it explicit and clean).
CHROMIUM_VERSION="$(cat "$APEX_ROOT/chromium_version.txt")"
CLANG_KEY="$(clang --version 2>/dev/null \
  | head -1 \
  | grep -oE 'version [0-9]+' \
  | awk '{print $2}')"
# -nomod suffix marks this as the no-modules-build ccache. Bump when the
# compile-flag set changes substantially.
CCACHE_KEY="ccache-${CHROMIUM_VERSION}-clang${CLANG_KEY:-unknown}-nomod.tar.zst"
export CCACHE_DIR="${CCACHE_DIR:-$WORK/.ccache}"
# CCACHE_BASEDIR rewrites absolute paths in compile commands to relative ones
# so the cache hashes match across different work dirs.
export CCACHE_BASEDIR="$WORK"
# Hash compiler binary by content, not mtime (mtime resets after tar extract).
export CCACHE_COMPILERCHECK="content"
# Cap on-disk size so we don't blow past the 200 GB EBS volume.
export CCACHE_MAXSIZE="50G"
mkdir -p "$CCACHE_DIR"
if [ -n "${BUILDER_CACHE_BUCKET:-}" ] \
     && [ -z "$(ls -A "$CCACHE_DIR" 2>/dev/null)" ] \
     && aws s3 ls "s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}" >/dev/null 2>&1; then
  echo "[ccache] HIT -- restoring s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}"
  aws s3 cp "s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}" - \
    | zstd -d --long=27 \
    | tar -x -C "$CCACHE_DIR"
  echo "[ccache] restored. stats:"
  ccache -s | head -20 || true
else
  echo "[ccache] MISS (or cache disabled) -- will populate during build"
fi

echo "=== apex-chromium build ==="

# Bootstrap depot_tools so the python3 wrapper can find its bundled interpreter.
# depot_tools/python3 reads $WORK/depot_tools/python3_bin_reldir.txt which is
# only written after the cipd bootstrap runs. Our cache-hit path skips gclient
# sync entirely so the marker is missing and `gn gen` fails with:
#   python3_bin_reldir.txt not found. need to initialize depot_tools by
#   running gclient, update_depot_tools or ensure_bootstrap.
# Bare `gclient` (no args) only prints usage and exits — does NOT bootstrap
# (verified empirically in build 224315: the warmup line ran but the same
# error fired immediately after). `ensure_bootstrap` is the canonical entry —
# it explicitly runs `cipd ensure` which writes python3_bin_reldir.txt.
echo "[0/2] ensuring depot_tools bootstrap (cipd + python3 wrapper) ..."
"$WORK/depot_tools/ensure_bootstrap"

echo "[1/2] gn gen ..."
gn gen out/apex

echo "[2/2] autoninja -- this is the long step (5-10h first build) ..."
autoninja -C out/apex chrome

# Report ccache stats post-build — measure cache hit rate / size for the
# next build's expected speedup. Hit rate is the most useful number: >80%
# means future warm builds will be ~5-10 min instead of ~50 min.
echo "[ccache] post-build stats:"
ccache -s 2>&1 | head -30 || true

# Persist ccache back to s3 so the next build can read it.
if [ -n "${BUILDER_CACHE_BUCKET:-}" ] && [ -d "$CCACHE_DIR" ]; then
  CCACHE_BYTES="$(du -sb "$CCACHE_DIR" 2>/dev/null | awk '{print $1}')"
  echo "[ccache] uploading to s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY} (raw size: ${CCACHE_BYTES} bytes) ..."
  tar -c -C "$CCACHE_DIR" . \
    | zstd -19 --long=27 -T0 \
    | aws s3 cp - "s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}" \
    || echo "      (ccache upload failed, continuing)"
fi

# Resolve the built binary path per-platform.
case "$(uname -s)" in
  Darwin) BIN="$SRC/out/apex/Chromium.app/Contents/MacOS/Chromium";;
  Linux)  BIN="$SRC/out/apex/chrome";;
  *)      BIN="$SRC/out/apex/chrome";;
esac

echo
echo "=== build complete ==="
echo " binary: $BIN"
echo
echo " point apex at it:"
echo "   export APEX_CHROME_PATH='$BIN'"
echo " then run the apex service -- it auto-detects APEX_CHROME_PATH."
