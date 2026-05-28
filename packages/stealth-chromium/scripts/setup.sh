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

# 2. Chromium checkout — ROLLING cache strategy.
#
# Old strategy (v2): one tarball PER Chromium version. Bumping version =
# cold full ~25min fetch. At weekly Chromium releases, that's ~$200/yr in
# wasted recompute just for the source step.
#
# New strategy (v3): ONE rolling tarball that always reflects the most
# recent successful setup. Restore unconditionally, then `git fetch --tags`
# + `gclient sync` the DELTA to the new target version. Patch-release
# deltas (e.g. 148.0.7778.179 → .215) are typically a few thousand objects
# and a handful of changed third_party submodules — pulls in ~3-8 min
# instead of ~25 min. Major-version bumps (148 → 149) are bigger but still
# benefit because git deltas against the closest existing ancestor.
#
# The sentinel file records WHICH version the cached tree was last synced
# to. Three cases:
#   1. sentinel matches current $CHROMIUM_VERSION: tree is exactly right,
#      skip step 3 entirely (fastest path — what every iterative build hits).
#   2. sentinel exists but for a different version: tree is "close enough",
#      run step 3 to fetch the version delta + gclient sync.
#   3. no sentinel (first-ever build, or after cache wipe): full fetch.
#
# Cache-key schema version:
#   v1 — original per-version layout (no sentinel)
#   v2 — added .apex-cache-ready-<version> sentinel
#   v3 — ROLLING: one tarball "chromium-src-rolling.tar.zst", sentinel
#        records last-synced version
CACHE_KEY="chromium-src-rolling-v3.tar.zst"
SENTINEL="$WORK/chromium/.apex-cache-ready"

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
    echo "$CHROMIUM_VERSION" > "$SENTINEL"
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

# 3. check out the target version + sync deps. Three sub-paths based on
# sentinel state:
#   (a) sentinel matches current version → skip (fastest path)
#   (b) sentinel exists for a different version → fetch the delta + sync
#   (c) no sentinel → step 2 just did a full fetch; record it and skip here
CACHED_VERSION=""
if [ -f "$SENTINEL" ]; then
  CACHED_VERSION="$(cat "$SENTINEL" 2>/dev/null || echo "")"
fi

# CACHE_DIRTY tracks whether the source tree CHANGED this run. We only
# re-upload the rolling cache when it did — re-uploading an unchanged 10 GiB
# tarball wastes ~5 min of zstd+S3 on every same-version iteration. Build
# #19 measured this: 27 min warm vs 18 min for the old per-version scheme,
# the 9-min gap was the needless re-upload.
CACHE_DIRTY=0
if [ "$CACHED_VERSION" = "$CHROMIUM_VERSION" ]; then
  echo "[3/3] cache already synced to $CHROMIUM_VERSION, skipping fetch + gclient sync"
elif [ -n "$CACHED_VERSION" ]; then
  echo "[3/3] cache was at $CACHED_VERSION, advancing to $CHROMIUM_VERSION ..."
  cd "$WORK/chromium/src"
  # IMPORTANT: the cached checkout is SHALLOW (fetch --no-history = depth 1).
  # A shallow clone has NO ancestor commits, so `git fetch <new-tag>` cannot
  # compute a delta against what we have — the server sends a self-contained
  # pack of ~13.5M objects (verified empirically: build #21 spent ~56 min in
  # index-pack on a "13579784"-object pack, same as a cold fetch).
  #
  # Fix: deepen the history enough that consecutive Chromium release tags
  # share ancestors. Chromium release tags within a major are typically tens
  # of commits apart on the release branch, so --deepen 500 gives git common
  # ancestors to delta against. The deepen itself transfers the missing
  # ancestor commits (one-time, ~a few hundred MB), but THEN the new-tag
  # fetch is a true small delta. Net: first cross-version bump after this
  # change pays the deepen cost; subsequent ones are cheap.
  echo "  deepening shallow history so the version delta can be computed ..."
  git fetch --deepen 500 origin 2>/dev/null || echo "  (deepen skipped — may already have history)"
  git fetch --tags origin "refs/tags/$CHROMIUM_VERSION" || true
  git checkout "tags/$CHROMIUM_VERSION" 2>/dev/null \
    || echo "  (tag checkout skipped -- staying on fetched revision)"
  # gclient sync pulls the third-party submodule deltas implied by the
  # new src/DEPS. -j 4 to stay under chromium.googlesource.com's burst
  # rate limit (HTTP 429 RESOURCE_EXHAUSTED).
  gclient sync -D --no-history --with_branch_heads -j 4
  echo "$CHROMIUM_VERSION" > "$SENTINEL"
  CACHE_DIRTY=1
else
  echo "[3/3] freshly fetched checkout — recording version $CHROMIUM_VERSION"
  echo "$CHROMIUM_VERSION" > "$SENTINEL"
  CACHE_DIRTY=1
fi

# Refresh the rolling cache ONLY when the tree changed (full fetch or
# version advance). On a same-version warm build, the tarball content is
# byte-identical to what's already in S3, so re-uploading is pure waste.
if [ -n "${BUILDER_CACHE_BUCKET:-}" ] && [ "$CACHE_DIRTY" = "1" ]; then
  echo "[3/3] tree changed — refreshing rolling cache at s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY} ..."
  tar -c -C "$WORK" chromium \
    | zstd -19 --long=27 -T0 \
    | aws s3 cp - "s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY}" \
        --expected-size 80000000000 \
    || echo "      (cache upload failed, continuing)"
elif [ -n "${BUILDER_CACHE_BUCKET:-}" ]; then
  echo "[3/3] tree unchanged since last build — rolling cache already current, skipping re-upload"
fi

echo
echo "=== setup complete ==="
echo " next: scripts/apply.sh   (copies overlays + applies patches)"
echo "       scripts/build.sh   (gn gen + autoninja -- multi-hour compile)"
