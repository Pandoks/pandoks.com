#!/usr/bin/env bash
# Validate a cloud-built stealth-chromium artifact and print the bake commands.
#
#   scripts/validate_artifact.sh [BUILD_ID]
#
# 1. Download + print <BUILD_ID>/manifest.json from the artifacts bucket.
# 2. Download chromium-<version>.tar.zst (with progress), `zstd -t` it,
#    check size against the manifest, record sha256, extract to
#    /var/tmp/stealth-artifact-<BUILD_ID>/.
# 3. Sanity-check the extracted binary: ELF x86-64, then `chrome --version`
#    and `--headless --dump-dom about:blank` inside a linux/amd64 container
#    (the binary is Linux; skipped with a note if docker is unavailable).
# 4. Print -- but do NOT run -- the docker build sequence from the Dockerfile
#    header (binary into packages/stealth-chromium/chromium/, context = repo root).
#
# Idempotent: a previously verified download/extract is reused; a partial
# download or extract is removed on failure. Nothing under the repo is touched.
#
# Env overrides: AWS_PROFILE (Personal), AWS_REGION (us-west-2),
#   ARTIFACTS_BUCKET, SKIP_DOCKER=1 (skip the in-container run).
set -euo pipefail

BUILD_ID="${1:-stealth-chromium-157-0-8103-27-16x-182556}"
BUCKET="${ARTIFACTS_BUCKET:-personal-pandoks-runnerartifactsstorebucket-uadorowo}"
export AWS_PROFILE="${AWS_PROFILE:-Personal}"
export AWS_REGION="${AWS_REGION:-us-west-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
PKG_REL="${PKG_ROOT#"$REPO_ROOT"/}"            # packages/stealth-chromium

WORK="/var/tmp/stealth-artifact-${BUILD_ID}"
S3_PREFIX="s3://${BUCKET}/${BUILD_ID}"
MANIFEST="$WORK/manifest.json"
EXTRACT="$WORK/chromium"

log()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Clean up partial state on failure. Finished steps leave a marker file so a
# rerun skips them; anything without a marker is treated as partial.
cleanup_on_fail() {
  local rc=$?
  [ "$rc" -eq 0 ] && return
  if [ -n "${PARTIAL:-}" ] && [ -e "$PARTIAL" ]; then
    echo "cleaning up partial: $PARTIAL" >&2
    rm -rf "$PARTIAL"
  fi
  exit "$rc"
}
trap cleanup_on_fail EXIT

for tool in aws zstd tar jq file shasum; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
done

mkdir -p "$WORK"

# --- 1. manifest ------------------------------------------------------------
log "manifest  ${S3_PREFIX}/manifest.json"
PARTIAL="$MANIFEST"
if ! aws s3 cp "${S3_PREFIX}/manifest.json" "$MANIFEST" --only-show-errors 2>"$WORK/manifest.err"; then
  rm -f "$MANIFEST"
  if grep -q '(404)' "$WORK/manifest.err"; then
    rm -f "$WORK/manifest.err"
    echo "manifest.json not found under ${S3_PREFIX}/"
    echo "The build has probably not finished (sfn-build uploads the manifest last)."
    echo "Objects present so far under the prefix (empty = nothing uploaded yet):"
    aws s3 ls "${S3_PREFIX}/" || true
    PARTIAL=""
    exit 2
  fi
  cat "$WORK/manifest.err" >&2
  die "could not download manifest (auth/region/bucket problem, see above)"
fi
rm -f "$WORK/manifest.err"
PARTIAL=""
jq . "$MANIFEST" || die "manifest.json is not valid JSON"

VERSION="$(jq -r '.version // empty' "$MANIFEST")"
KEY="$(jq -r '.key // empty' "$MANIFEST")"
SIZE_CLAIM="$(jq -r '.sizeBytes // empty' "$MANIFEST")"
M_BUILD_ID="$(jq -r '.buildId // empty' "$MANIFEST")"
[ -n "$VERSION" ] && [ -n "$KEY" ] && [ -n "$SIZE_CLAIM" ] \
  || die "manifest is missing version/key/sizeBytes"
[ "$M_BUILD_ID" = "$BUILD_ID" ] \
  || die "manifest buildId '$M_BUILD_ID' != requested '$BUILD_ID'"

EXPECTED_VERSION="$(cat "$PKG_ROOT/chromium_version.txt")"
if [ "$VERSION" != "$EXPECTED_VERSION" ]; then
  echo "WARNING: manifest version $VERSION != $PKG_REL/chromium_version.txt ($EXPECTED_VERSION)"
fi

TARBALL="$WORK/$(basename "$KEY")"

log "S3 object metadata  s3://${BUCKET}/${KEY}"
aws s3api head-object --bucket "$BUCKET" --key "$KEY" \
  | jq '{ContentLength, ETag, LastModified, Metadata}'
S3_LEN="$(aws s3api head-object --bucket "$BUCKET" --key "$KEY" --query ContentLength --output text)"
[ "$S3_LEN" = "$SIZE_CLAIM" ] \
  || die "S3 ContentLength $S3_LEN != manifest sizeBytes $SIZE_CLAIM"

# --- 2. tarball: download, verify, extract ------------------------------------
if [ -f "$TARBALL.verified" ] && [ -f "$TARBALL" ]; then
  log "tarball already downloaded and verified: $TARBALL (delete $TARBALL.verified to redo)"
else
  log "download  s3://${BUCKET}/${KEY}  ->  $TARBALL  (${SIZE_CLAIM} bytes)"
  rm -f "$TARBALL" "$TARBALL.verified"
  PARTIAL="$TARBALL"
  aws s3 cp "s3://${BUCKET}/${KEY}" "$TARBALL"      # aws cli prints progress to a tty

  ACTUAL_SIZE="$(stat -f%z "$TARBALL" 2>/dev/null || stat -c%s "$TARBALL")"
  [ "$ACTUAL_SIZE" = "$SIZE_CLAIM" ] \
    || die "downloaded size $ACTUAL_SIZE != manifest sizeBytes $SIZE_CLAIM"
  echo "size ok: $ACTUAL_SIZE bytes"

  log "zstd -t"
  zstd -t --long=27 "$TARBALL"
  touch "$TARBALL.verified"
  PARTIAL=""
fi

log "sha256 (manifest carries no hash; recorded for your own bookkeeping)"
shasum -a 256 "$TARBALL" | tee "$TARBALL.sha256"

if [ -f "$EXTRACT/.extracted" ]; then
  log "already extracted: $EXTRACT (delete it to re-extract)"
else
  log "extract  ->  $EXTRACT"
  rm -rf "$EXTRACT"
  mkdir -p "$EXTRACT"
  PARTIAL="$EXTRACT"
  # sfn-build packs the files flat (chrome, *.pak, locales/, ...), no top dir.
  zstd -d --long=27 -c "$TARBALL" | tar -x -C "$EXTRACT"
  touch "$EXTRACT/.extracted"
  PARTIAL=""
fi
ls -la "$EXTRACT"

# --- 3. binary sanity --------------------------------------------------------
CHROME="$EXTRACT/chrome"
[ -f "$CHROME" ] || die "no 'chrome' at the top level of the tarball"
chmod +x "$CHROME"

log "file type"
FILE_OUT="$(file -b "$CHROME")"
echo "$FILE_OUT"
case "$FILE_OUT" in
  *ELF*x86-64*|*ELF*x86_64*) echo "ok: ELF x86-64" ;;
  *) die "chrome is not an ELF x86-64 binary" ;;
esac
for req in icudtl.dat resources.pak chrome_100_percent.pak snapshot_blob.bin v8_context_snapshot.bin locales; do
  [ -e "$EXTRACT/$req" ] || echo "WARNING: expected file missing from tarball: $req"
done

if [ "${SKIP_DOCKER:-0}" = "1" ]; then
  log "SKIP_DOCKER=1: not running the binary"
elif ! docker info >/dev/null 2>&1; then
  log "docker not available: skipping --version / --dump-dom (binary is Linux x86_64)"
else
  log "run inside linux/amd64 container (installs the Dockerfile's runtime deps; slow under emulation)"
  docker run --rm --platform linux/amd64 \
    -v "$EXTRACT":/opt/stealth-chromium:ro \
    -e DEBIAN_FRONTEND=noninteractive \
    python:3.12-slim-bookworm bash -euo pipefail -c '
      apt-get update -qq >/dev/null
      apt-get install -y -qq --no-install-recommends \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
        libcairo2 libasound2 libatspi2.0-0 libx11-xcb1 libxcb-dri3-0 libxshmfence1 \
        libgtk-3-0 fonts-liberation >/dev/null
      cd /opt/stealth-chromium
      echo "--- chrome --version"
      ./chrome --version
      echo "--- chrome --headless --dump-dom about:blank"
      ./chrome --headless --no-sandbox --disable-gpu --dump-dom about:blank
    ' 2>&1 | tee "$WORK/container-run.log"
  if grep -q "$VERSION" "$WORK/container-run.log"; then
    echo "ok: --version reports $VERSION"
  else
    echo "WARNING: container output does not mention manifest version $VERSION (see $WORK/container-run.log)"
  fi
fi

# --- 4. bake commands (printed only) ------------------------------------------
TAG="stealth-browser:${VERSION}-${BUILD_ID}"
cat <<EOF

==> VALIDATED. To bake the image, run from the repo root ($REPO_ROOT):

  # 1. put the extracted binary where the Dockerfile COPYs it from
  rm -rf $PKG_REL/chromium
  mkdir -p $PKG_REL/chromium
  tar -C $EXTRACT --exclude=.extracted -cf - . | tar -C $PKG_REL/chromium -xf -

  # 2. build with the repo root as context (linux/amd64 binary)
  docker build --platform linux/amd64 \\
    -f $PKG_REL/Dockerfile \\
    -t $TAG \\
    -t stealth-browser:latest \\
    .

  # 3. smoke-run (Rosetta on Apple Silicon: slow to boot)
  docker run --rm --platform linux/amd64 -p 41000:41000 $TAG

Artifact dir: $WORK  (rerun this script to reuse it; rm -rf to start over)
EOF
