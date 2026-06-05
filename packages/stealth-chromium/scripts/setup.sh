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
CHROMIUM_VERSION="$("$APEX_ROOT/scripts/resolve-chromium-version.sh")"

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

# CACHE_DIRTY tracks whether the source tree CHANGED this run. Declared HERE
# (before step 2) because BOTH step 2 (cache miss → full fetch) and step 3
# (version advance) can dirty the tree, and the single upload at the end
# fires when either did. BUG FIXED (builds #18-#28 never persisted a rolling
# cache): the old code declared CACHE_DIRTY inside step 3, so a cache-MISS
# fetch in step 2 wrote the sentinel, step 3 then saw sentinel==version and
# took the skip path (CACHE_DIRTY stayed 0), and the upload never ran. Every
# build cold-fetched the source. Hoisting the flag + setting it in the miss
# branch is the fix.
CACHE_DIRTY=0

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
    # NOTE: do NOT write the sentinel here. `fetch chromium` lands on ToT
    # (main), NOT $CHROMIUM_VERSION -- recording the version now would make
    # step 3 believe the tree is already at the pin and skip the tag checkout,
    # which is exactly the bug that shipped ToT mislabelled as the pin. Step 3
    # checks the real chrome/VERSION and does the checkout.
    CACHE_DIRTY=1  # fresh fetch → tree is new → must upload the rolling cache
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

# 3. Ensure the checkout is EXACTLY at the pinned tag. Ground truth is the
# tree's own chrome/VERSION file, NOT the sentinel: the sentinel only records
# INTENT, but a fresh `fetch chromium` lands on ToT and a failed tag checkout
# leaves a stale tree -- neither of which the sentinel can detect. Reading
# chrome/VERSION is the only honest signal of what will actually be compiled.
# (Builds #18-#N silently shipped ToT mislabelled as the pin because the
# sentinel said "synced" while the tree was never checked out to the tag.)
cd "$WORK/chromium/src"

read_tree_version() {
  awk -F= '
    /^MAJOR=/{a=$2} /^MINOR=/{b=$2} /^BUILD=/{c=$2} /^PATCH=/{d=$2}
    END { if (a != "") print a"."b"."c"."d }
  ' chrome/VERSION 2>/dev/null
}

TREE_VERSION="$(read_tree_version)"
if [ "$TREE_VERSION" != "$CHROMIUM_VERSION" ]; then
  echo "[3/3] tree at '${TREE_VERSION:-unknown}', checking out $CHROMIUM_VERSION ..."
  # Explicit DESTINATION refspec (…:refs/tags/X) so the tag ref is created
  # LOCALLY. `git fetch origin refs/tags/X` alone only writes FETCH_HEAD, so a
  # later `git checkout tags/X` finds no ref and (previously, silently) left
  # the tree on ToT. depth 1 keeps the rolling cache lean (see invariant #6).
  git fetch --depth 1 origin \
    "refs/tags/$CHROMIUM_VERSION:refs/tags/$CHROMIUM_VERSION"
  # -f discards the prior build's apex working-tree patches so the tree is
  # pristine for apply.sh to re-apply every edit cleanly (a stale partial
  # patch is how the apex-platform edit silently dropped out of a build).
  git checkout -f "refs/tags/$CHROMIUM_VERSION"
  # Pin gclient to the SAME tag so third_party matches the checked-out src.
  # -j 4 stays under chromium.googlesource.com's burst rate limit (HTTP 429).
  gclient sync -D --no-history --with_branch_heads \
    --revision "src@refs/tags/$CHROMIUM_VERSION" -j 4
  CACHE_DIRTY=1
else
  echo "[3/3] tree already at $CHROMIUM_VERSION"
  # Right version, but the cached tree may still carry the prior build's apex
  # working-tree patches. Revert tracked files to pristine so apply.sh
  # re-applies every edit fresh (untracked apex_*.h headers are harmless and
  # get re-copied by apply.sh). Reverting to the cached-pristine state does
  # NOT change the tree vs S3, so CACHE_DIRTY stays 0 -- no needless re-upload.
  git checkout -f -- . 2>/dev/null || true
fi

# Fail-fast: NEVER compile (and then mislabel) a tree that isn't the pin. A
# mismatch here means the checkout above didn't take -- abort rather than ship
# the wrong revision. This is the guard that the whole pipeline lacked.
TREE_VERSION="$(read_tree_version)"
if [ "$TREE_VERSION" != "$CHROMIUM_VERSION" ]; then
  echo "ERROR: checkout is at '${TREE_VERSION:-unknown}', expected $CHROMIUM_VERSION -- aborting."
  exit 1
fi
echo "[3/3] verified tree is at $CHROMIUM_VERSION"
echo "$CHROMIUM_VERSION" > "$SENTINEL"
cd "$WORK"

# Refresh the rolling cache ONLY when the tree changed (full fetch or
# version advance). On a same-version warm build, the tarball content is
# byte-identical to what's already in S3, so re-uploading is pure waste.
if [ -n "${BUILDER_CACHE_BUCKET:-}" ] && [ "$CACHE_DIRTY" = "1" ]; then
  echo "[3/3] tree changed — refreshing rolling cache at s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY} ..."
  # De-bloat before compressing: a fresh `fetch` lands on ToT and the
  # subsequent tag checkout leaves BOTH versions' git objects in src/.git,
  # ballooning the cache (~10 GiB -> ~90 GiB). git gc --prune=now repacks and
  # drops the unreachable ToT objects. Also exclude src/out (build output is
  # NOT source; ccache is the compile cache) so the tarball stays lean.
  echo "      de-bloating src/.git (git gc) ..."
  git -C "$WORK/chromium/src" gc --prune=now --quiet 2>/dev/null || true
  # --expected-size sizes the S3 multipart chunks (cap is 10000 parts). The
  # old 80 GB hint silently FAILED to upload a tree that exceeded it (a bloated
  # cache once hit 90 GiB compressed), leaving the cache stuck at a stale
  # version forever -- every build then re-downgraded and re-failed in a loop.
  # 300 GB of headroom (30 MB parts) covers even a pathologically bloated tree;
  # a healthy lean tree (~10 GiB) is unaffected.
  tar -c -C "$WORK" --exclude='chromium/src/out' chromium \
    | zstd -19 --long=27 -T0 \
    | aws s3 cp - "s3://${BUILDER_CACHE_BUCKET}/${CACHE_KEY}" \
        --expected-size 300000000000 \
    || echo "      (cache upload failed, continuing)"
elif [ -n "${BUILDER_CACHE_BUCKET:-}" ]; then
  echo "[3/3] tree unchanged since last build — rolling cache already current, skipping re-upload"
fi

echo
echo "=== setup complete ==="
echo " next: scripts/apply.sh   (copies overlays + applies patches)"
echo "       scripts/build.sh   (gn gen + autoninja -- multi-hour compile)"
