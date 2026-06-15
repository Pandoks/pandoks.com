#!/usr/bin/env bash
# Geo-endpoint finder: which IP-geolocation API both (a) works through the
# Oxylabs residential exit (many reset the TLS handshake -- ipinfo, browserleaks,
# ipapi.co) AND (b) returns a usable timezone, so the browser identity's timezone
# can be matched to the exit IP (the timezone<->IP mismatch is what iphey /
# browserscan flag as "trying to hide your location"). curl-only; creds + hosts
# arrive as plaintext env vars in the SFN command (owner-approved).
set -uo pipefail

# Runner (infra/runner/) exports RUNNER_*; map to the legacy names this
# script reads (builder->runner rename).
: "${BUILDER_ARTIFACTS_BUCKET:=${RUNNER_ARTIFACTS_BUCKET:-}}"
: "${BUILD_ID:=${RUNNER_JOB_ID:-}}"
: "${BUILDER_CACHE_BUCKET:=${RUNNER_CACHE_BUCKET:-}}"
export HOME="${HOME:-/root}"
WORK=/tmp/proxycurl
mkdir -p "$WORK"
LOG="$WORK/proxy-curl.log"
exec > >(tee "$LOG") 2>&1
S3="s3://${BUILDER_ARTIFACTS_BUCKET}/${BUILD_ID}"
trap 'aws s3 cp "$LOG" "${S3}/proxy-curl.log" >/dev/null 2>&1 || true' EXIT

U="${OXYLABS_USERNAME:-}"
P="${OXYLABS_PASSWORD:-}"
HOSTS="${OXYLABS_PROXIES:-${OXYLABS_RESIDENTIAL_PROXIES:-}}"
H1="$(printf '%s' "$HOSTS" | cut -d, -f1)"
PX="http://${U}-session-geofind:${P}@${H1}:60000"
echo "host1=$H1 user_len=${#U} pass_len=${#P}"

for url in \
  "https://ip.oxylabs.io/location" \
  "https://ipapi.co/json/" \
  "https://ipwho.is/" \
  "https://get.geojs.io/v1/ip/geo.json" \
  "https://api.ip.sb/geoip" \
  "https://ipapi.is/json/" \
  "https://freeipapi.com/api/json"; do
  echo "============================================================"
  echo "=== $url ==="
  out=$(curl -s --max-time 35 -x "$PX" "$url")
  rc=$?
  echo "rc=$rc len=${#out}"
  # show whether a timezone is present + the body (truncated)
  printf '%s' "$out" | grep -oiE '"?time[_]?zone[^,}"]*"?[: ]*"?[A-Za-z]+/[A-Za-z_]+' | head -2
  echo "BODY: ${out:0:500}"
done
echo "=== done ==="
