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

# Restore ccache from s3 if available -- 30-50GB of compiler cache cuts an
# incremental rebuild from 5h to ~30min. Keyed per chromium-version + clang
# major so a toolchain bump invalidates.
CHROMIUM_VERSION="$(cat "$APEX_ROOT/chromium_version.txt")"
# Extract clang major version. clang --version output on Ubuntu:
#   "Ubuntu clang version 18.1.3 (1ubuntu1)"
# The previous "awk '{print $NF}' | cut -d. -f1" grabbed "(1ubuntu1)" — the
# Ubuntu package-revision suffix in parens, NOT the version number. Build
# 003811 produced "ccache-148.0.7778.179-clang(1ubuntu1).tar.zst" (76 bytes,
# empty tarball) because the wrong key was used. grep-pattern is robust to
# whatever vendor prefix clang prints.
CLANG_KEY="$(clang --version 2>/dev/null \
  | head -1 \
  | grep -oE 'version [0-9]+' \
  | awk '{print $2}')"
CCACHE_KEY="ccache-${CHROMIUM_VERSION}-clang${CLANG_KEY:-unknown}.tar.zst"
export CCACHE_DIR="${CCACHE_DIR:-$WORK/.ccache}"
# CCACHE_BASEDIR rewrites absolute paths in compile commands to relative ones
# so the cache hashes match across different work dirs. Without this, every
# EC2 instance's $WORK path differs and ccache misses on every compile even
# when contents are identical. With it, the cache is portable across instances.
export CCACHE_BASEDIR="$WORK"
# Tell ccache to hash on file content + size, not mtime (which differs after
# every tar extract from S3). Without this every cache restore from S3 would
# invalidate the entire cache.
export CCACHE_COMPILERCHECK="content"
# CCACHE_SLOPPINESS=modules lets ccache cache C++20-modules-using compiles.
# By default ccache marks any compile with -fmodules as "uncacheable" because
# .pcm (precompiled module) files reference transitive include content ccache
# can't fully hash. Chromium uses modules HEAVILY — build 140538 showed 88%
# of compile calls (60111/68179) were uncacheable, making ccache nearly
# useless. With this sloppiness, ccache trusts source + flags + .pcm file
# paths/mtimes as the key. Small risk of stale cached objects if .pcm
# content changes without path change, mitigated by CCACHE_COMPILERCHECK
# (above) and the fact that .pcm regeneration always bumps mtime.
# Also: time_macros + locale + system_headers tolerate __DATE__/__TIME__
# in source (rare in Chromium) and locale-sensitive output differences.
export CCACHE_SLOPPINESS="modules,time_macros,locale,system_headers,include_file_mtime,include_file_ctime,pch_defines"
# Cap ccache disk usage so it doesn't blow past the 200 GB EBS volume. 50 GB
# is roughly the size of a fully-populated Chromium ccache.
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
