#!/usr/bin/env bash
# Run the fingerprinter panel THROUGH the Oxylabs residential proxy, so the
# IP-dependent detectors (iphey/browserscan/deviceinfo/Cloudflare + mobile) see
# a residential exit IP instead of the EC2 datacenter IP.
#
# Creds + hosts arrive as env vars set in the SFN command. The builder boxes are
# private and ephemeral, so plaintext injection is acceptable (owner-approved) --
# and the box cannot resolve SST secrets itself: the minimal instance role has
# neither the four provider tokens nor s3:GetObject on the SST state bucket, and
# the secrets live encrypted in that state bucket (not as plain SSM params).
#
# The browser core's proxy.from_env() reads OXYLABS_USERNAME / OXYLABS_PASSWORD /
# OXYLABS_PROXIES and routes every session through a sticky residential exit IP.
#   command="bash -c \"export OXYLABS_USERNAME='...'; export OXYLABS_PASSWORD='...'; \
#     export OXYLABS_PROXIES='h1.hbproxy.net,...'; export APEX_PROFILE=RTX; \
#     bash packages/stealth-chromium/scripts/run-panel-proxied.sh\""
set -uo pipefail
export HOME="${HOME:-/root}"
# Runner (infra/runner/) exports RUNNER_ARTIFACTS_BUCKET/RUNNER_JOB_ID; map to the
# legacy names this script (and the run-panel.sh it execs) read.
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
export BUILDER_ARTIFACTS_BUCKET BUILD_ID
PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# proxy.py reads OXYLABS_PROXIES; accept the longer alias the earlier command used.
export OXYLABS_USERNAME="${OXYLABS_USERNAME:-}"
export OXYLABS_PASSWORD="${OXYLABS_PASSWORD:-}"
export OXYLABS_PROXIES="${OXYLABS_PROXIES:-${OXYLABS_RESIDENTIAL_PROXIES:-}}"

# Own log + upload trap: run-panel.sh only starts uploading once it is reached,
# so an early abort here (missing creds) would otherwise leave no artifact.
WORK=/tmp/proxiedpanel
mkdir -p "$WORK"
LOG="$WORK/proxied-panel.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/proxied-panel.log" >/dev/null 2>&1 || true' EXIT

echo "=== proxied panel: persona='${APEX_PROFILE:-<host-matched>}' ==="
echo "  oxylabs env: user_len=${#OXYLABS_USERNAME} pass_len=${#OXYLABS_PASSWORD} hosts=$(printf '%s' "$OXYLABS_PROXIES" | tr ',' '\n' | grep -c .)"
if [ -z "$OXYLABS_USERNAME" ] || [ -z "$OXYLABS_PASSWORD" ] || [ -z "$OXYLABS_PROXIES" ]; then
  echo "ERROR: oxylabs creds/hosts unavailable -- aborting proxied panel"
  exit 1
fi

bash "$PKG_ROOT/scripts/run-panel.sh"
