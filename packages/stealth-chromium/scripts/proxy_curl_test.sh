#!/usr/bin/env bash
# Isolation diagnostic: does the Oxylabs residential proxy work from a clean-
# egress EC2 box, independent of the browser? curl-only (no Chrome, no CDP
# Fetch), so it separates "proxy reachable + creds valid + residential exit IP"
# from the browser-integration question. Captures curl -v so the proxy's actual
# CONNECT response (200 / 407 / error body / cert) is visible, and tries a few
# username suffix forms since the hbproxy SKU mandates a "-<suffix>". Creds +
# hosts arrive as plaintext env vars in the SFN command (owner-approved).
#   command="bash -c \"export OXYLABS_USERNAME='...'; export OXYLABS_PASSWORD='...'; \
#     export OXYLABS_PROXIES='h1.hbproxy.net,...'; \
#     bash packages/stealth-chromium/scripts/proxy_curl_test.sh\""
set -uo pipefail
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
echo "creds: user_len=${#U} pass_len=${#P} hosts=$(printf '%s' "$HOSTS" | tr ',' '\n' | grep -c .) host1=$H1"
echo "curl: $(curl --version | head -1)"

# show only the proxy/tunnel-relevant verbose lines (CONNECT, status, TLS,
# Proxy-Authenticate) + the body, never the Proxy-Authorization (has the creds).
filter() { grep -iE 'CONNECT |HTTP/|Proxy-Auth|certificate|SSL|TLS|alert|denied|error|< |^\{' | grep -ivE 'Proxy-Authorization' | head -25; }

try() { # $1 = label, $2 = full proxy URL, $3 = target URL
  echo "=== $1 -> $3 ==="
  out=$(curl -sv --max-time 40 -x "$2" "$3" 2>"$WORK/err.txt")
  rc=$?
  echo "  rc=$rc body_len=${#out}"
  filter <"$WORK/err.txt"
  [ -n "$out" ] && echo "  BODY: ${out:0:200}"
}

echo "### A. bare username (expect 407 per SKU) ###"
try "bare-https" "http://${U}:${P}@${H1}:60000" "https://ipinfo.io/json"

echo "### B. -session-<id> suffix (current proxy.py form) ###"
try "session-https" "http://${U}-session-abc123:${P}@${H1}:60000" "https://ipinfo.io/json"

echo "### C. simple -<id> suffix ###"
try "simple-https" "http://${U}-abc123:${P}@${H1}:60000" "https://ipinfo.io/json"

echo "### D. -session-<id> against an HTTP target (SKU note: http may be empty) ###"
try "session-http" "http://${U}-session-abc123:${P}@${H1}:60000" "http://ip-api.com/json"

echo "### E. -session-<id> to oxylabs' own ip endpoint ###"
try "session-oxy" "http://${U}-session-abc123:${P}@${H1}:60000" "https://ip.oxylabs.io/location"

echo "=== done ==="
