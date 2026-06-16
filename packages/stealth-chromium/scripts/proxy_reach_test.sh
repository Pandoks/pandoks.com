#!/usr/bin/env bash
# Browser-free reachability probe: curl each target THROUGH the Oxylabs
# residential proxy and report the exact failure point, to settle WHY the
# browser saw ERR_CONNECTION_CLOSED on certain domains.
#
# For each domain x (fresh sticky session each), it shows:
#   * whether the upstream CONNECT returned 200 (tunnel established) vs refused
#     (provider destination block -> non-200),
#   * whether the end-to-end TLS handshake to the target then completed or was
#     reset/closed (target/exit-node dropping the connection),
#   * the final curl exit code.
# Creds + hosts arrive as plaintext env vars in the SFN command (owner-approved).
set -uo pipefail
export HOME="${HOME:-/root}"
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
WORK=/tmp/proxyreach
mkdir -p "$WORK"
LOG="$WORK/proxy-reach.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/proxy-reach.log" >/dev/null 2>&1 || true' EXIT

U="${OXYLABS_USERNAME:-}"
P="${OXYLABS_PASSWORD:-}"
HOSTS="${OXYLABS_PROXIES:-${OXYLABS_RESIDENTIAL_PROXIES:-}}"
if [ -z "$U" ] || [ -z "$P" ] || [ -z "$HOSTS" ]; then
  echo "ERROR: oxylabs creds/hosts unavailable"
  exit 1
fi
echo "user_len=${#U} pass_len=${#P} hosts=$(printf '%s' "$HOSTS" | tr ',' '\n' | grep -c .)"

# domains: the ones the browser COULD reach (control) + the ones it could not.
TARGETS="https://example.com/ https://www.browserscan.net/ https://ip.oxylabs.io/location https://tls.peet.ws/api/all https://datadome.co/ https://demo.fingerprint.com/ https://bot.incolumitas.com/ https://nowsecure.nl/ https://deviceandbrowserinfo.com/"

host_for() {  # pick a random host per call -> fresh exit
  printf '%s' "$HOSTS" | tr ',' '\n' | grep . | shuf | head -1
}

for url in $TARGETS; do
  H="$(host_for)"
  SID="reach$(date +%s%N | tail -c 6)"
  PX="http://${U}-session-${SID}:${P}@${H}:60000"
  echo "============================================================"
  echo "=== $url  (exit host ...$(printf '%s' "$H" | tail -c 18)) ==="
  # -v to stderr (merged); capture key lines: CONNECT status, TLS, final code.
  out="$(curl -sS -v -x "$PX" --max-time 35 -o /dev/null \
    -w 'FINAL http_code=%{http_code} exitcode=%{exitcode} time=%{time_total}s\n' \
    "$url" 2>&1)"
  echo "$out" | grep -iE 'CONNECT |Proxy replied|HTTP/1\.1 200 Connection|TLS handshake|SSL connection using|TLSv|Empty reply|Connection reset|Recv failure|Could not|error:|FINAL ' | head -12
done
echo "=== proxy-reach done ==="
