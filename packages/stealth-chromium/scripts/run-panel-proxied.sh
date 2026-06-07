#!/usr/bin/env bash
# Run the fingerprinter panel THROUGH the Oxylabs residential proxy, so the
# IP-dependent detectors (iphey/browserscan/deviceinfo/Cloudflare + mobile) see
# a residential exit IP. Credentials handling:
#   * user/pass  -> read from SST secrets via `sst shell` (sanctioned; never in
#     the SFN command). SSM shell has no $HOME, so set it (sst panics otherwise).
#   * host list  -> $OXYLABS_RESIDENTIAL_PROXIES (passed in the command -- it's
#     an endpoint list, useless without the creds, so not a secret).
#   * persona    -> $APEX_PROFILE (also passed; not sensitive).
#   command="bash -c \"export OXYLABS_RESIDENTIAL_PROXIES='...'; export APEX_PROFILE='...'; bash packages/stealth-chromium/scripts/run-panel-proxied.sh\""
set -uo pipefail
export HOME="${HOME:-/root}"
PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"

if [ "${1:-}" = "--inner" ]; then
  # Running INSIDE `sst shell`: SST_RESOURCE_* are set. Pull the Oxylabs creds
  # into the env names proxy.py reads, never echoing the values.
  export OXYLABS_USERNAME="$(python3 -c "import os,json;print(json.loads(os.environ.get('SST_RESOURCE_OxylabsResidentialUsername','{}')).get('value',''))")"
  export OXYLABS_PASSWORD="$(python3 -c "import os,json;print(json.loads(os.environ.get('SST_RESOURCE_OxylabsResidentialPassword','{}')).get('value',''))")"
  export OXYLABS_PROXIES="${OXYLABS_RESIDENTIAL_PROXIES:-}"
  echo "  oxylabs creds: user_len=${#OXYLABS_USERNAME} pass_len=${#OXYLABS_PASSWORD} hosts=$(printf '%s' "$OXYLABS_PROXIES" | tr ',' '\n' | grep -c .)"
  if [ -z "$OXYLABS_USERNAME" ] || [ -z "$OXYLABS_PASSWORD" ] || [ -z "$OXYLABS_PROXIES" ]; then
    echo "ERROR: oxylabs creds/hosts unavailable -- aborting proxied panel"; exit 1
  fi
  bash "$PKG_ROOT/scripts/run-panel.sh"
  exit $?
fi

# --- outer: own log+upload trap (run-panel.sh's upload only fires once we reach
# it; without this a failure in setup/sst-shell uploads nothing) ---
WORK=/tmp/proxiedpanel; mkdir -p "$WORK"
LOG="$WORK/proxied-panel.log"; exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/proxied-panel.log" >/dev/null 2>&1 || true' EXIT

echo "=== proxied panel: persona='${APEX_PROFILE:-<host-matched>}' hosts=$(printf '%s' "${OXYLABS_RESIDENTIAL_PROXIES:-}" | tr ',' '\n' | grep -c .) ==="
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1 || true
  sudo apt-get install -y -qq nodejs >/dev/null 2>&1 || true
fi
corepack enable >/dev/null 2>&1 || true
echo "  node=$(node -v 2>&1) pnpm=$(pnpm -v 2>&1 | tail -1)"
cd "$REPO_ROOT"
echo "=== pnpm install ==="
pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -3 || echo "  (pnpm install warn)"
echo "=== entering sst shell (creds) -> run-panel ==="
pnpm sst shell --stage production -- bash "$PKG_ROOT/scripts/run-panel-proxied.sh" --inner
echo "=== proxied panel done (rc=$?) ==="
