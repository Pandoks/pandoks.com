#!/usr/bin/env bash
# Isolation diagnostic: does the Oxylabs residential proxy work from a clean-
# egress EC2 box, independent of the browser? curl-only (no Chrome, no CDP
# Fetch), so it separates "proxy reachable + creds valid + residential exit IP"
# from the browser-integration question. Creds + hosts arrive as plaintext env
# vars in the SFN command (owner-approved; private ephemeral box).
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
echo "creds: user_len=${#U} pass_len=${#P} hosts=$(printf '%s' "$HOSTS" | tr ',' '\n' | grep -c .)"
IFS=',' read -ra HARR <<<"$HOSTS"

parse='import sys,json
try:
 d=json.load(sys.stdin)
 print("  ip=%s org=%s city=%s region=%s country=%s" % (
   d.get("ip"), d.get("org") or d.get("asn",{}).get("name"),
   d.get("city"), d.get("region"), d.get("country")))
except Exception as e:
 print("  parse/empty:", e)'

echo "=== DIRECT (no proxy -- should be the EC2 datacenter IP) ==="
out=$(curl -s --max-time 20 https://ipinfo.io/json)
rc=$?
echo "  rc=$rc len=${#out}"
printf '%s' "$out" | python3 -c "$parse"

echo "=== TCP reachability to first host:60000 ==="
python3 - "$HOSTS" <<'PY'
import socket, sys
h = sys.argv[1].split(",")[0].strip()
try:
    ip = socket.gethostbyname(h)
    print(f"  DNS {h} -> {ip}")
    s = socket.socket(); s.settimeout(10)
    s.connect((ip, 60000)); print(f"  TCP {h}:60000 CONNECTED"); s.close()
except Exception as e:
    print(f"  TCP {h}:60000 FAILED: {e}")
PY

i=0
for h in "${HARR[@]}"; do
  i=$((i + 1))
  [ "$i" -gt 3 ] && break
  px="http://${U}-session-curl${i}:${P}@${h}:60000"
  echo "=== PROXY host=$h (sticky session curl${i}) ==="
  out=$(curl -s --max-time 45 -x "$px" https://ipinfo.io/json)
  rc=$?
  echo "  curl_rc=$rc len=${#out}"
  printf '%s' "$out" | python3 -c "$parse"
done
echo "=== done ==="
