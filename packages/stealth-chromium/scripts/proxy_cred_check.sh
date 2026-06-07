#!/usr/bin/env bash
# Diagnostic: can the builder EC2 box read the Oxylabs SST secrets via the
# sanctioned `sst shell` (so creds never touch the SFN command)? Reports only
# whether each secret env is SET (+ length), never the value. Hosts arrive via
# $OXYLABS_RESIDENTIAL_PROXIES (passed in the command -- not a credential).
#   command="bash -c \"export OXYLABS_RESIDENTIAL_PROXIES='...'; bash packages/stealth-chromium/scripts/proxy_cred_check.sh\""
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK=/tmp/proxycred; mkdir -p "$WORK"
LOG="$WORK/proxy-cred-check.log"; exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/proxy-cred-check.log" >/dev/null 2>&1 || true' EXIT

n=$(printf '%s' "${OXYLABS_RESIDENTIAL_PROXIES:-}" | tr ',' '\n' | grep -c .)
echo "hosts passed via command: count=$n"
echo "=== node + pnpm ==="
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1 || true
  sudo apt-get install -y -qq nodejs >/dev/null 2>&1 || true
fi
corepack enable >/dev/null 2>&1 || true
echo "node: $(node -v 2>&1) | pnpm: $(pnpm -v 2>&1 | tail -1)"
cd "$REPO_ROOT"
echo "=== pnpm install (no scripts) ==="
pnpm install --frozen-lockfile --ignore-scripts >/dev/null 2>&1 && echo "install OK" || echo "install FAILED"
echo "=== sst shell secret exposure (values redacted) ==="
pnpm sst shell --stage production -- sh -c '
  for v in SST_RESOURCE_OxylabsResidentialUsername SST_RESOURCE_OxylabsResidentialPassword; do
    eval "val=\${$v:-}"
    if [ -n "$val" ]; then echo "$v SET (len ${#val})"; else echo "$v MISSING"; fi
  done
  echo "all SST_RESOURCE_* names:"; env | grep -o "^SST_RESOURCE_[A-Za-z]*" | sort -u
' 2>&1 | tail -25
echo "=== done ==="
