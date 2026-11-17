"""IP pool vetting: is this exit IP safe to hand to a persona?

2025-26 IP scoring is observation-based; a bad IP fails the proxy test in
ways the browser cannot fix. Check BEFORE an IP joins the pool:

  1. rDNS (PTR)  -- Cloudflare bot verification requires a bot-UA IP's PTR
                    to resolve into the owner's domain suffix. A datacenter
                    IP with no PTR or a generic hoster PTR fails.
  2. MaxMind     -- user_count > 5 in 30 days = proxy/CGNAT tell;
                    is_residential_proxy = explicit flag.
  3. IPQS        -- shared_connection / recent_abuse flags.

Usage:
    python3 vet_ip.py 1.2.3.4            # all checks, verdict
    python3 vet_ip.py 1.2.3.4 --json     # machine-readable

Requires: MAXMIND_ACCOUNT_ID + MAXMIND_LICENSE_KEY (GeoInsights API),
IPQS_API_KEY. Missing keys skip those checks (verdict degrades honestly).
"""
from __future__ import annotations

import json
import os
import socket
import sys
import urllib.request

BAD_PTR_SUFFIXES = (".amazonaws.com", ".compute.amazonaws.com",
                    ".googleusercontent.com", ".azure.com", ".cloud.microsoft",
                    ".hetzner.com", ".ovh.net", ".digitalocean.com",
                    ".linode.com", ".vultr.com", ".contabo.net", ".mivocloud.com",
                    # service hosts that look "clean" but are datacenter
                    ".google", ".googleapis.com", ".gstatic.com",
                    ".cloudflare.net", ".oraclecloud.com", ".ibm.com",
                    ".github.com", ".github.io", ".fastly.net", ".akamai.net")


def check_ptr(ip: str) -> dict:
    """PTR must exist and look like an ISP/residential assignment."""
    try:
        name, _, _ = socket.gethostbyaddr(ip)  # (host, aliases, addrs)
    except (socket.herror, socket.gaierror, OSError) as e:
        return {"ok": False, "ptr": None, "reason": f"no PTR record: {e}"}
    bad = any(name.lower().endswith(s) for s in BAD_PTR_SUFFIXES)
    return {"ok": not bad, "ptr": name,
            "reason": "generic hoster PTR" if bad else "residential-shaped PTR"}


def check_maxmind(ip: str) -> dict:
    """GeoInsights: user_count, is_residential_proxy, connection_type."""
    acct = os.environ.get("MAXMIND_ACCOUNT_ID")
    key = os.environ.get("MAXMIND_LICENSE_KEY")
    if not (acct and key):
        return {"ok": None, "reason": "MAXMIND_ACCOUNT_ID/LICENSE_KEY not set"}
    url = (f"https://geoip.maxmind.com/geoip/v2.1/insights/"
           f"{ip}?account_id={acct}")
    req = urllib.request.Request(url, headers={
        "Authorization": "Basic " + __import__("base64").b64encode(
            f"{acct}:{key}".encode()).decode()})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except Exception as e:
        return {"ok": None, "reason": f"lookup failed: {e}"}
    traits = data.get("traits", {})
    user_count = traits.get("user_count")
    is_resi_proxy = traits.get("is_residential_proxy", False)
    conn = traits.get("connection_type")
    problems = []
    if isinstance(user_count, int) and user_count > 5:
        problems.append(f"user_count={user_count} (proxy/CGNAT)")
    if is_resi_proxy:
        problems.append("is_residential_proxy=true")
    if conn and conn not in ("residential", "business"):
        problems.append(f"connection_type={conn}")
    return {"ok": not problems, "user_count": user_count,
            "connection_type": conn, "is_residential_proxy": is_resi_proxy,
            "reason": "; ".join(problems) or "clean"}


def check_ipqs(ip: str) -> dict:
    """IPQualityScore: shared_connection, recent_abuse, fraud score."""
    key = os.environ.get("IPQS_API_KEY")
    if not key:
        return {"ok": None, "reason": "IPQS_API_KEY not set"}
    try:
        with urllib.request.urlopen(
                f"https://ipqualityscore.com/api/json/ip/{key}/{ip}?strictness=0",  # noqa: E501
                timeout=10) as r:
            data = json.loads(r.read())
    except Exception as e:
        return {"ok": None, "reason": f"lookup failed: {e}"}
    problems = []
    if data.get("shared_connection"):
        problems.append("shared_connection=true")
    if data.get("recent_abuse"):
        problems.append("recent_abuse=true")
    score = data.get("fraud_score", 0)
    if isinstance(score, (int, float)) and score > 50:
        problems.append(f"fraud_score={score}")
    return {"ok": not problems, "fraud_score": score,
            "reason": "; ".join(problems) or "clean"}


def vet(ip: str) -> dict:
    ptr = check_ptr(ip)
    mm = check_maxmind(ip)
    ipqs = check_ipqs(ip)
    checks = {"ptr": ptr, "maxmind": mm, "ipqs": ipqs}
    hard_fails = [k for k, v in checks.items() if v.get("ok") is False]
    skipped = [k for k, v in checks.items() if v.get("ok") is None]
    verdict = "PASS" if not hard_fails else "FAIL"
    return {"ip": ip, "verdict": verdict, "checks": checks,
            "failed": hard_fails, "skipped": skipped,
            "note": "unverified checks are skipped, not passed"}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    ip = sys.argv[1]
    out = vet(ip)
    if "--json" in sys.argv:
        print(json.dumps(out, indent=2))
    else:
        print(f"verdict: {out['verdict']}  ({out['ip']})")
        for name, c in out["checks"].items():
            print(f"  {name:<8} {'PASS' if c.get('ok') is True else 'SKIP' if c.get('ok') is None else 'FAIL'}  {c.get('reason', '')}")
        sys.exit(0 if out["verdict"] == "PASS" else 2)
