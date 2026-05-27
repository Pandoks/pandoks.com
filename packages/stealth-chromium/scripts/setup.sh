#!/usr/bin/env bash
# apex-chromium: one-time toolchain + Chromium source setup.
#
# Fetches depot_tools and a pristine Chromium checkout pinned to the version in
# chromium_version.txt. This is the ~100GB, ~30-90min step -- run it once.
#
# Patches/overlays are NOT applied here; that is scripts/apply.sh, which is
# fast and re-runnable.
set -euo pipefail

APEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${APEX_CHROMIUM_WORK:-$HOME/apex-chromium-build}"
CHROMIUM_VERSION="$(cat "$APEX_ROOT/chromium_version.txt")"

echo "=== apex-chromium setup ==="
echo " work dir         : $WORK"
echo " Chromium version : $CHROMIUM_VERSION"
echo " disk needed      : ~100GB checkout + ~30GB build output"
echo

mkdir -p "$WORK"
cd "$WORK"

# 1. depot_tools
if [ ! -d "$WORK/depot_tools" ]; then
  echo "[1/3] cloning depot_tools ..."
  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
fi
export PATH="$WORK/depot_tools:$PATH"

# 2. Chromium checkout. Prefer the s3 cache if BUILDER_CACHE_BUCKET points at
# a bucket that has a usable tarball for our pinned version. Falls back to a
# full ~100GB depot_tools `fetch` if the cache miss is total.
#
# The cache object key is keyed on the version string so a bump to
# chromium_version.txt invalidates automatically. Tarball is `tar | zstd -19`
# of the whole $WORK/chromium tree -- depot_tools state + src/ + deps.
CACHE_KEY="chromium-src-${CHROMIUM_VERSION}.tar.zst"
if [ ! -d "$WORK/chromium/src" ]; then
  if [ -n "${BUILDER_CACHE_BUCKET:-}" ] \
       && aws s3 ls "s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY}" >/dev/null 2>&1; then
    echo "[2/3] cache HIT -- restoring s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY}"
    aws s3 cp "s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY}" - \
      | zstd -d --long=27 \
      | tar -x -C "$WORK"
  else
    echo "[2/3] cache MISS -- fetching Chromium (the long step) ..."
    mkdir -p "$WORK/chromium"
    cd "$WORK/chromium"
    fetch --no-history chromium
    cd "$WORK"
    if [ -n "${BUILDER_CACHE_BUCKET:-}" ]; then
      echo "      uploading checkout to s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY} ..."
      tar -c -C "$WORK" chromium \
        | zstd -19 --long=27 -T0 \
        | aws s3 cp - "s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY}" \
            --expected-size 80000000000 \
        || echo "      (cache upload failed, continuing)"
    fi
  fi
else
  echo "[2/3] Chromium checkout already present locally, skipping fetch"
fi

# 3. check out the pinned version + sync deps
echo "[3/3] checking out $CHROMIUM_VERSION and syncing deps ..."
cd "$WORK/chromium/src"
# Skip refetch when the cached tarball already contains the tag (warm-cache
# path saves ~80 min of single-threaded git index-pack on the 13.5M-object
# pack — that step took 1h 19min in the 184805 build attempt).
if ! git rev-parse "tags/$CHROMIUM_VERSION" >/dev/null 2>&1; then
  git fetch --tags --depth 1 origin "refs/tags/$CHROMIUM_VERSION" || true
fi
git checkout "tags/$CHROMIUM_VERSION" 2>/dev/null \
  || echo "  (tag checkout skipped -- staying on fetched revision)"
# -j 4: throttle parallel git fetches so the secondary DEPS pulls don't trip
# chromium.googlesource.com's per-IP burst rate limit (HTTP 429 RESOURCE_EXHAUSTED).
# Default is 8*cpu_count which on c8i.16xlarge = 512 parallel fetches — guaranteed
# 429. The 184805 build died at libvpx with this exact error.
gclient sync -D --no-history --with_branch_heads -j 4

echo
echo "=== setup complete ==="
echo " next: scripts/apply.sh   (copies overlays + applies patches)"
echo "       scripts/build.sh   (gn gen + autoninja -- multi-hour compile)"
