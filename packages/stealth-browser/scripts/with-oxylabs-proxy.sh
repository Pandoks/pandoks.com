#!/usr/bin/env bash
# Bridge the Oxylabs Web Unblocker SST secrets into the PROXY_* env vars that
# stealth_browser/proxy.py reads, then exec the given command (the service, a
# test, etc.) with the proxy wired in.
#
# WHY this bridge exists: proxy.py reads PLAIN env vars
# (PROXY_HOST/PORT/USER/PASS/SCHEME), NOT SST `Resource.*`. The credentials
# live in SST secrets (OxylabsWebUnblockerUsername / ...Password). This script
# is the seam between the two.
#
# WIRING FACTS (verified against Oxylabs docs, 2026-06):
#   * Endpoint is FIXED: unblock.oxylabs.io:60000 (managed-unblocking endpoint,
#     NOT a residential rotating proxy).
#   * Auth is HTTP Basic, username:password used AS-IS -- there is NO
#     {session}/{peer} username templating (that is for residential SKUs). So
#     PROXY_USER_TEMPLATE is intentionally left UNSET.
#   * Web Unblocker terminates/!inspects TLS (it is a MITM unblocker), so the
#     target's certificate is replaced by Oxylabs' CA. A browser routed through
#     it must trust that CA (install it) or run with cert errors ignored. This
#     is inherent to Web Unblocker and is at odds with the stealth stack's
#     "authentic end-to-end TLS fingerprint" design -- use a residential SKU
#     when an untouched TLS handshake matters.
#
# Usage:
#   scripts/with-oxylabs-proxy.sh [--stage STAGE] -- <command...>
# Example:
#   scripts/with-oxylabs-proxy.sh --stage production -- \
#     env APEX_CORE=patchright APEX_CHROME_PATH=/opt/stealth-chromium/chrome \
#         uv run stealth-browser
set -euo pipefail

STAGE="production"
if [ "${1:-}" = "--stage" ]; then
  STAGE="${2:?--stage needs a value}"
  shift 2
fi
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "usage: $0 [--stage STAGE] -- <command...>" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Read the two secrets from SST. `pnpm sst secret list` prints NAME=VALUE lines.
secret() {
  (cd "$REPO_ROOT" && pnpm sst secret list --stage "$STAGE" 2>/dev/null) \
    | sed -n "s/^$1=//p"
}

PROXY_USER_VALUE="$(secret OxylabsWebUnblockerUsername)"
PROXY_PASS_VALUE="$(secret OxylabsWebUnblockerPassword)"
if [ -z "$PROXY_USER_VALUE" ] || [ -z "$PROXY_PASS_VALUE" ]; then
  echo "ERROR: Oxylabs Web Unblocker secrets not set for stage '$STAGE'." >&2
  echo "       Expected OxylabsWebUnblockerUsername / OxylabsWebUnblockerPassword." >&2
  exit 1
fi

export PROXY_HOST="unblock.oxylabs.io"
export PROXY_PORT="60000"
export PROXY_SCHEME="https"
export PROXY_USER="$PROXY_USER_VALUE"
export PROXY_PASS="$PROXY_PASS_VALUE"
# Explicitly UNSET any residential-style template so the WU username is used
# verbatim (see WIRING FACTS above).
unset PROXY_USER_TEMPLATE || true
# Web Unblocker terminates TLS, so Chrome must tolerate its CA (or you install
# the Oxylabs CA cert). This opt-in is read by profile.chrome_launch_flags.
export APEX_PROXY_IGNORE_CERT="1"

echo "[with-oxylabs-proxy] PROXY_HOST=$PROXY_HOST PROXY_PORT=$PROXY_PORT" \
     "PROXY_SCHEME=$PROXY_SCHEME PROXY_USER=${PROXY_USER%%_*}_*** (as-is)" >&2
exec "$@"
