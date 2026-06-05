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

# Go env for dawn/tint's code generator. Chromium's WebGPU layer (dawn) runs
# a bundled Go binary (third_party/dawn/tools/golang/.../go) to generate tint
# shader-language enum sources during the build. On a fresh EC2 instance the
# SSM-RunShellScript context has no usable $HOME (see "Can't resolve $HOME"
# warnings from depot_tools throughout the logs), so Go can't find a default
# module cache and dies with:
#   go: module cache not found: neither GOMODCACHE nor GOPATH is set
# This failed build #25 at the dawn:generate_sources ACTION (~step 6535).
# Earlier builds masked it because the cached source tree still had stale
# pre-generated tint outputs; a truly clean fetch exposes it. Point Go's
# caches at writable dirs under $WORK.
export GOPATH="$WORK/.gopath"
export GOMODCACHE="$WORK/.gopath/pkg/mod"
export GOCACHE="$WORK/.gocache"
mkdir -p "$GOPATH" "$GOMODCACHE" "$GOCACHE"

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
CHROMIUM_VERSION="$("$APEX_ROOT/scripts/resolve-chromium-version.sh")"
# Chromium MAJOR version (e.g. "148" from "148.0.7778.179"). Key ccache on
# major rather than full version so patch releases (148.0.7778.179 → .215)
# can REUSE most cached objects. Hit rate empirically ~10-25% on patch
# bumps because Chromium has high inter-version source churn — but even
# 15% hit rate cuts ~10 min off an 80-min cold build.
#
# Major-version bumps (148 → 149) clear the cache (different key), which
# is correct: source files change too much for cross-major reuse to be
# safe in practice (~80% would miss anyway).
CHROMIUM_MAJOR="${CHROMIUM_VERSION%%.*}"
CLANG_KEY="$(clang --version 2>/dev/null \
  | head -1 \
  | grep -oE 'version [0-9]+' \
  | awk '{print $2}')"
# Key: chromium-MAJOR + clang-major + flags-shape suffix.
#   -nomod  — built with use_clang_modules=false (the ABI-relevant flag).
# Bump the suffix when args.gn changes substantially (compile flags affect
# the hash anyway, but namespacing makes the boundary explicit).
CCACHE_KEY="ccache-chromium${CHROMIUM_MAJOR}-clang${CLANG_KEY:-unknown}-nomod.tar.zst"
export CCACHE_DIR="${CCACHE_DIR:-$WORK/.ccache}"
# CCACHE_BASEDIR rewrites absolute paths in compile commands to relative ones
# so the cache hashes match across different work dirs.
export CCACHE_BASEDIR="$WORK"
# Hash compiler binary by content, not mtime (mtime resets after tar extract).
export CCACHE_COMPILERCHECK="content"
# Cap on-disk size so we don't blow past the 200 GB EBS volume.
export CCACHE_MAXSIZE="50G"
mkdir -p "$CCACHE_DIR"
CCACHE_SIZE_BEFORE=0
if [ -n "${BUILDER_CACHE_BUCKET:-}" ] \
     && [ -z "$(ls -A "$CCACHE_DIR" 2>/dev/null)" ] \
     && aws s3 ls "s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}" >/dev/null 2>&1; then
  echo "[ccache] HIT -- restoring s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}"
  aws s3 cp "s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}" - \
    | zstd -d --long=27 \
    | tar -x -C "$CCACHE_DIR"
  echo "[ccache] restored. stats:"
  ccache -s | head -20 || true
  # Record post-restore size so we can detect whether the build added enough
  # new objects to justify re-uploading the (3.5 GiB) tarball afterward.
  CCACHE_SIZE_BEFORE="$(du -sb "$CCACHE_DIR" 2>/dev/null | awk '{print $1}')"
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

# --- apex-platform diagnostic ----------------------------------------------
# navigator.platform spoof (APEX_FP_PLATFORM) has silently failed to land in
# the binary across multiple builds via BOTH an anchor edit and a full-file
# overlay, while every other patch lands. This pinpoints WHERE it is lost:
#   source patched?  -> overlay/apply worked
#   in an .o?        -> compiled in (so loss is at link/strip) vs not (ccache
#                       stale, or the apex code compiled out / jumbo issue)
# Compared against APEX_FP_UA_PLATFORM, a sibling patch that DOES land.
echo "=== apex-platform diagnostic ==="
_navsrc="$SRC/third_party/blink/renderer/core/frame/navigator_id.cc"
echo " source navigator_id.cc APEX_FP_PLATFORM hits: $(grep -c APEX_FP_PLATFORM "$_navsrc" 2>/dev/null || echo NA)"
echo " is there a standalone navigator_id .o (vs jumbo)?:"
find "$SRC/out/apex/obj/third_party/blink" -name '*navigator_id*' 2>/dev/null | head -5
echo " .o objects containing APEX_FP_PLATFORM (should-be navigator_id):"
{ find "$SRC/out/apex/obj/third_party/blink" -name '*.o' 2>/dev/null \
  | xargs -r grep -lZ APEX_FP_PLATFORM 2>/dev/null | tr '\0' '\n' | head -5; } || true
echo " .o objects containing APEX_FP_UA_PLATFORM (control -- this one lands):"
{ find "$SRC/out/apex/obj/third_party/blink" -name '*.o' 2>/dev/null \
  | xargs -r grep -lZ APEX_FP_UA_PLATFORM 2>/dev/null | tr '\0' '\n' | head -5; } || true
echo "=== end apex-platform diagnostic ==="

# Report ccache stats post-build — measure cache hit rate / size for the
# next build's expected speedup. Hit rate is the most useful number: >80%
# means future warm builds will be ~5-10 min instead of ~50 min.
echo "[ccache] post-build stats:"
ccache -s 2>&1 | head -30 || true

# Persist ccache back to s3 — but ONLY if the build added a meaningful amount
# of new objects. On a same-version warm build with ~99% hits, ccache grows by
# only a few MB (the handful of misses), and re-uploading the full 3.5 GiB
# tarball to capture that wastes ~4 min. Build #19 measured this overhead.
# Threshold: re-upload if cache grew by >100 MB OR if it was a cold cache
# (CCACHE_SIZE_BEFORE=0 means no restore happened, so we must upload).
if [ -n "${BUILDER_CACHE_BUCKET:-}" ] && [ -d "$CCACHE_DIR" ]; then
  CCACHE_SIZE_AFTER="$(du -sb "$CCACHE_DIR" 2>/dev/null | awk '{print $1}')"
  CCACHE_GROWTH=$(( CCACHE_SIZE_AFTER - CCACHE_SIZE_BEFORE ))
  UPLOAD_THRESHOLD=$((100 * 1024 * 1024)) # 100 MB
  if [ "$CCACHE_SIZE_BEFORE" = "0" ] || [ "$CCACHE_GROWTH" -gt "$UPLOAD_THRESHOLD" ]; then
    echo "[ccache] grew by ${CCACHE_GROWTH} bytes (>threshold or cold) — uploading to s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY} ..."
    tar -c -C "$CCACHE_DIR" . \
      | zstd -19 --long=27 -T0 \
      | aws s3 cp - "s3://${BUILDER_CACHE_BUCKET}/${CCACHE_KEY}" \
      || echo "      (ccache upload failed, continuing)"
  else
    echo "[ccache] grew by only ${CCACHE_GROWTH} bytes (<100 MB) — S3 cache already current, skipping re-upload"
  fi
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
