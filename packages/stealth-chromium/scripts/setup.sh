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

# The cloud runner exports RUNNER_CACHE_BUCKET; the older builder exported
# BUILDER_CACHE_BUCKET (the name this script's checks read). Accept either so
# a runner-driven build uses the rolling cache instead of re-fetching 70GB.
BUILDER_CACHE_BUCKET="${BUILDER_CACHE_BUCKET:-${RUNNER_CACHE_BUCKET:-}}"

# chromium.googlesource.com drops long HTTPS fetches ("the remote end hung
# up unexpectedly" / truncated body). One failure must not kill the build:
# retry the tag fetch a few times with backoff before giving up.
git_fetch_with_retry() {
  local dir="$1" url="$2" ref="$3" attempt
  for attempt in 1 2 3 4 5; do
    if git -C "$dir" fetch --tags --depth 1 "$url" "$ref"; then
      return 0
    fi
    echo "      git fetch attempt $attempt failed; retrying in 15s ..."
    sleep 15
  done
  echo "      git fetch failed after 5 attempts"
  return 1
}

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
# The runner runs as root with no $HOME: depot_tools refuses to self-init
# ("Running depot tools as root is sad" / "Can't resolve $HOME") and a FRESH
# clone is unbootstrapped (python3_bin_reldir.txt missing). Set HOME, bypass
# the auto-update root check, run the explicit bootstrap (it's a bash script),
# then hard-fail if gclient is still unusable.
export DEPOT_TOOLS_UPDATE=0
export HOME="${HOME:-/root}"
echo "[1.5/3] bootstrapping depot_tools ..."
bash "$WORK/depot_tools/ensure_bootstrap" || \
  "$WORK/depot_tools/update_depot_tools" || true
"$WORK/depot_tools/gclient" --version >/dev/null

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
    echo "$CHROMIUM_VERSION" > "$SENTINEL"
    CACHE_DIRTY=1  # fresh fetch → tree is new → must upload the rolling cache
  fi
else
  echo "[2/3] Chromium checkout already present locally, skipping fetch"
fi

# The anchor set is the contract between the patches and the pinned source.
# A rolling cache can carry a tree from an earlier run at the WRONG revision
# (e.g. a run that recorded the sentinel before the tag pin existed -- that
# is exactly what poisoned build c2x-v6: the drifted c2x-080211 tree was
# cached, and every later build restored it and skipped the pin). Verify the
# anchors on whatever tree we now have; if they don't match the pinned
# release, force the checkout + sync.
if [ -d "$WORK/chromium/src" ] \
     && ! APEX_CHROMIUM_WORK="$WORK" python3 "$APEX_ROOT/scripts/apply_edits.py" --check >/dev/null 2>&1; then
  echo "[2/3] tree fails the anchor check -- pinning to $CHROMIUM_VERSION ..."
  cd "$WORK/chromium/src"
  git_fetch_with_retry "$WORK/chromium/src" origin "refs/tags/$CHROMIUM_VERSION"
  git checkout "tags/$CHROMIUM_VERSION"
  # gclient sync resolves .gclient by walking UP from cwd, so it must run from
  # inside the tree (src/) — the cache-MISS and version-advance sites do the
  # same. From $WORK there is no .gclient: "Error: client not configured"
  # (build 16x-182556 died here on the first-ever anchor-check pin).
  gclient sync -D --no-history --with_branch_heads -j 4
  echo "$CHROMIUM_VERSION" > "$SENTINEL"
  CACHE_DIRTY=1
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

# The sentinel records what we WROTE, not what the tree IS. A tree that
# predates the tag pin (e.g. fetched to main-branch tip before the pin
# existed) carries drifted sources: 26 of 28 anchors still match, so the
# anchor check passes, but the build compiles the WRONG revision and dies
# on moved identifiers (build 16x-170059: text_metrics.cc main-tip had no
# font_ member). Ground truth is git, so require the tree to actually BE at
# the pinned tag before trusting the skip path.
AT_PINNED_TAG=0
if [ -d "$WORK/chromium/src" ]; then
  TREE_REF="$(git -C "$WORK/chromium/src" describe --tags --exact-match HEAD 2>/dev/null || echo "")"
  if [ "$TREE_REF" = "$CHROMIUM_VERSION" ]; then
    AT_PINNED_TAG=1
  fi
fi

if [ "$CACHED_VERSION" = "$CHROMIUM_VERSION" ] && [ "$AT_PINNED_TAG" = "1" ]; then
  echo "[3/3] cache synced AND pinned to $CHROMIUM_VERSION, skipping fetch + gclient sync"
elif [ -n "$CACHED_VERSION" ]; then
  echo "[3/3] cache was at $CACHED_VERSION, advancing to $CHROMIUM_VERSION ..."
  cd "$WORK/chromium/src"
  # The cached checkout is SHALLOW (fetch --no-history = depth 1). A shallow
  # clone has no ancestor commits, so `git fetch <new-tag>` can't delta — it
  # pulls a self-contained ~13.5M-object pack (~25 min index-pack).
  #
  # We deliberately DON'T try to make this cheaper via `git fetch --deepen`.
  # Build #22 measured that: deepen DID make the new-tag fetch fast, but it
  # ballooned the rolling cache from 10 GiB → 35 GiB (all the pulled ancestor
  # history), which then slows the cache RESTORE on EVERY build — including
  # the common same-version-iteration path (17 min → ~24 min). Net-negative:
  # it speeds the rare weekly version bump by ~12 min while taxing every
  # patch-iteration build by ~7 min. Wrong trade.
  #
  # Instead: accept the ~25-min cold source fetch on version bumps (it's
  # inherent to shallow Chromium checkouts). The major-version-keyed ccache
  # (see build.sh) still provides the cross-version COMPILE savings, which is
  # where the real cost lives anyway. Keep the rolling cache lean (depth-1).
  git_fetch_with_retry "$WORK/chromium/src" origin "refs/tags/$CHROMIUM_VERSION"
  git checkout "tags/$CHROMIUM_VERSION"
  # gclient sync pulls the third-party submodule deltas implied by the
  # new src/DEPS. -j 4 to stay under chromium.googlesource.com's burst
  # rate limit (HTTP 429 RESOURCE_EXHAUSTED).
  gclient sync -D --no-history --with_branch_heads -j 4
  echo "$CHROMIUM_VERSION" > "$SENTINEL"
  CACHE_DIRTY=1
else
  # A fresh `fetch chromium` lands on the main-branch TIP, not the release
  # tag -- the patch anchors are verified against the exact release, so pin
  # the tree to the tag here too, or the edits drift (build 157-c2x-080211).
  echo "[3/3] freshly fetched checkout — pinning to the $CHROMIUM_VERSION tag ..."
  cd "$WORK/chromium/src"
  git_fetch_with_retry "$WORK/chromium/src" origin "refs/tags/$CHROMIUM_VERSION"
  git checkout "tags/$CHROMIUM_VERSION"
  # Run from src/ — gclient needs to find .gclient by walking up from cwd.
  gclient sync -D --no-history --with_branch_heads -j 4
  cd "$WORK"
  echo "$CHROMIUM_VERSION" > "$SENTINEL"
  CACHE_DIRTY=1
fi

# --- Widevine CDM bundling input -------------------------------------------
# bundle_widevine_cdm=true (build/args.gn) makes the build copy the CDM files
# from third_party/widevine/cdm/{linux,x64}/ into out/apex/WidevineCdm/. The
# src-internal checkout would provide them; we fetch the identical files from
# the Chrome-for-Testing build of the SAME Chromium version (pure CDN, no
# auth, no accounts). SHA256 pins below match 157.0.8103.38; a version bump
# needs its own pins.
fetch_widevine_cdm() {
  wv_dir="$WORK/chromium/src/third_party/widevine/cdm"
  wv_so="$wv_dir/linux/x64/libwidevinecdm.so"
  wv_manifest="$wv_dir/linux/x64/manifest.json"
  wv_so_sha="cd250e8177183add7029ccc3057217b978779f9c7af800c45083f3cc0139020e"
  wv_manifest_sha="106559aa573088d9436609452fd0ec85d19a4475a500526950d2ef4fae2a7ca4"
  wv_check_sha() {
    if [ "$CHROMIUM_VERSION" = "157.0.8103.38" ]; then
      echo "$wv_so_sha  $wv_so" | shasum -a 256 -c - >/dev/null 2>&1 \
        && echo "$wv_manifest_sha  $wv_manifest" | shasum -a 256 -c - >/dev/null 2>&1
    else
      # Version not covered by the pins: just require presence, and say so.
      [ -f "$wv_so" ] && [ -f "$wv_manifest" ]
    fi
  }
  if [ -f "$wv_so" ] && [ -f "$wv_manifest" ] && wv_check_sha; then
    echo "[3.5/3] Widevine CDM input files present and verified"
    return 0
  fi
  if [ -f "$wv_so" ] || [ -f "$wv_manifest" ]; then
    echo "[3.5/3] CDM files present but unverified -- re-fetching"
    rm -f "$wv_so" "$wv_manifest"
  fi
  echo "[3.5/3] fetching Widevine CDM input files ($CHROMIUM_VERSION) ..."
  wv_zip_dir=$(mktemp -d)
  if ! curl -fsSL -o "$wv_zip_dir/cft.zip" \
       "https://storage.googleapis.com/chrome-for-testing-public/${CHROMIUM_VERSION}/linux64/chrome-linux64.zip"; then
    rm -rf "$wv_zip_dir"
    echo "      ERROR: no chrome-linux64.zip for $CHROMIUM_VERSION at the CFT bucket." >&2
    echo "      Pin the CDM files manually at $wv_dir/{linux,x64}/ and re-run setup." >&2
    return 1
  fi
  python3 - "$wv_zip_dir/cft.zip" "$wv_zip_dir" <<'PYEOF'
import sys, zipfile
zip_path, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as z:
    z.extract("chrome-linux64/WidevineCdm/manifest.json", out)
    z.extract(
        "chrome-linux64/WidevineCdm/_platform_specific/linux_x64/libwidevinecdm.so",
        out)
PYEOF
  mkdir -p "$wv_dir/linux/x64"
  mv "$wv_zip_dir/chrome-linux64/WidevineCdm/manifest.json" "$wv_manifest"
  mv "$wv_zip_dir/chrome-linux64/WidevineCdm/_platform_specific/linux_x64/libwidevinecdm.so" "$wv_so"
  rm -rf "$wv_zip_dir"
  if ! wv_check_sha; then
    echo "      ERROR: CDM SHA256/presence check failed for $CHROMIUM_VERSION" >&2
    return 1
  fi
  echo "[3.5/3] Widevine CDM input files verified"
}
fetch_widevine_cdm || exit 1

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
