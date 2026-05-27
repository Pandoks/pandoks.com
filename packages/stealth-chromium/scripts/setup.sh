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
# Cache-key schema version. Bump whenever the tarball CONTENTS shape changes
# (e.g. adding a sentinel marker, including ccache, packing more dirs) so
# the new code doesn't try to interpret a tarball written under old rules.
# Independent of CHROMIUM_VERSION which captures the source-tree version.
#   v1 — original layout (chromium/ tarball, no sentinel)
#   v2 — adds .apex-cache-ready-<version> sentinel, gclient sync runs with -j 4
CACHE_KEY="chromium-src-${CHROMIUM_VERSION}-v2.tar.zst"
# Sentinel file written after a successful checkout — its presence is the
# load-bearing signal that the entire setup (fetch + gclient sync) finished
# and was tarballed. The cache-write step is the only thing that creates it,
# so its presence in a restored tarball means "this tree is fully synced for
# this exact version" — and step 3 (refetch + checkout + gclient sync) can
# be safely skipped. Saves ~80 min of single-threaded git index-pack on the
# 13.5M-object pack that the 184805/210904 builds wasted time on, and
# eliminates the chromium.googlesource.com 429 rate-limit class of failures
# entirely on warm cache hits.
SENTINEL="$WORK/chromium/.apex-cache-ready-${CHROMIUM_VERSION}"

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
    cd "$WORK/chromium/src"
    # -j 4: throttle parallel git fetches so the DEPS pulls don't trip
    # chromium.googlesource.com's per-IP burst rate limit (HTTP 429
    # RESOURCE_EXHAUSTED). Default is 8*cpu_count which on c8i.16xlarge
    # is 512 parallel fetches — guaranteed 429. 184805 died here.
    gclient sync -D --no-history --with_branch_heads -j 4
    cd "$WORK"
    touch "$SENTINEL"
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

# 2.5 — install Chromium's system build dependencies. Always runs because the
# AMI is Ubuntu base (no Chromium-specific packages baked in) and even
# cache-hit builds land on a fresh EC2 with no system pkgs from prior runs.
# The script is canonical upstream so it adapts to whatever new dep Chromium
# adds in any release.
#
# Flags chosen:
#   --no-prompt           -- non-interactive (required for SSM-driven runs)
#   --no-chromeos-fonts   -- we don't build ChromeOS, skip 200 MB of fonts
#   --no-nacl             -- NaCl is removed from Chromium, skip its leftover deps
#   --no-arm              -- we build x86_64 only on x86 AMIs, skip cross-arch libs
#
# Without this, gn gen fails as build 230610 did with:
#   ERROR at //build/config/linux/atk/BUILD.gn:24:17: Script returned non-zero exit code.
#   FileNotFoundError: [Errno 2] No such file or directory: 'pkg-config'
#
# Idempotent: apt-get install is a no-op on a fully-installed system, so
# warm-cache builds re-running this just pay the ~10s "already installed"
# check cost (not the 5-10min install cost).
echo "[2.5/3] installing Chromium build dependencies (apt) ..."
sudo "$WORK/chromium/src/build/install-build-deps.sh" \
  --no-prompt --no-chromeos-fonts --no-nacl --no-arm

# 3. check out the pinned version + sync deps -- ONLY on cache miss or
# pre-sentinel cache. The sentinel is created by the cache-write path
# above, so if it's present in the restored tarball we know setup is done.
if [ -f "$SENTINEL" ]; then
  echo "[3/3] cache is fully synced (sentinel found), skipping fetch + gclient sync"
else
  echo "[3/3] checking out $CHROMIUM_VERSION and syncing deps ..."
  cd "$WORK/chromium/src"
  git fetch --tags --depth 1 origin "refs/tags/$CHROMIUM_VERSION" || true
  git checkout "tags/$CHROMIUM_VERSION" 2>/dev/null \
    || echo "  (tag checkout skipped -- staying on fetched revision)"
  # -j 4 rate-limit cap (see comment in cache-MISS path above).
  gclient sync -D --no-history --with_branch_heads -j 4
  touch "$SENTINEL"
fi

echo
echo "=== setup complete ==="
echo " next: scripts/apply.sh   (copies overlays + applies patches)"
echo "       scripts/build.sh   (gn gen + autoninja -- multi-hour compile)"
