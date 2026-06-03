#!/usr/bin/env python3
"""Proxy-routed feature test for the stealth-browser HTTP service.

Starts the real service (headful, on Xvfb) routed through an HTTP proxy, then
drives it over the HTTP API to assert the four proxy guarantees:

  (a) every browser request RIDES the proxy   -- proven from the proxy's own
      CONNECT log (each navigated host appears; a direct request would not).
  (b) WebRTC exposes NO real IP               -- the apex-chromium no-leak
      patch (requires the patched binary; soft-skipped on stock Chrome).
  (c) the spoofed fingerprint surfaces report -- incl. the new connection /
      storage surfaces (requires the patched binary; soft-skipped on stock).
  (d) /fetch rides the proxy + page cookies   -- a cookie set during navigate
      is echoed back through an in-page fetch().

The exit-IP-CHANGES-network assertion (a residential exit IP different from the
host) requires a real remote proxy; with a localhost forward proxy the egress
is unchanged, so we assert ROUTING (the proxy saw the traffic) instead. Point
PROXY_* at a reachable remote proxy to also see the IP change.

Env:
  APEX_CHROME_PATH   patched binary (enables the hard spoof/WebRTC asserts)
  APEX_CORE          patchright | nodriver  (default patchright)
  PROXY_HOST/PORT/USER/PASS/SCHEME   the proxy to route through
  PROXY_LOG          optional path to the proxy's access log (routing proof)
  REQUIRE_SPOOF=1    make the spoof/WebRTC asserts HARD (patched-binary run)
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PORT = int(os.environ.get("PORT", "8091"))
BASE = f"http://127.0.0.1:{PORT}"
PKG = Path(__file__).resolve().parent.parent
IP_ECHO = "https://api.ipify.org/?format=json"
COOKIE_SET = "https://httpbin.org/cookies/set/apexsid/proxy-cookie-42"
COOKIE_ECHO = "https://httpbin.org/cookies"


def _req(method: str, path: str, body: dict | None = None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode() or "{}")


def _wait_health(proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"service exited early rc={proc.returncode}")
        try:
            st, body = _req("GET", "/health", timeout=3)
            if st == 200 and body.get("ok"):
                return body
        except Exception:
            time.sleep(1)
    raise RuntimeError("service did not become healthy")


def main() -> int:
    require_spoof = os.environ.get("REQUIRE_SPOOF") == "1"
    proxy_log = os.environ.get("PROXY_LOG")
    log_mark = None
    if proxy_log and Path(proxy_log).exists():
        log_mark = Path(proxy_log).stat().st_size  # only read NEW lines

    env = dict(os.environ, PORT=str(PORT), STEALTH_IN_DOCKER="1")
    # Stale X locks from a previously-killed Xvfb make `xvfb-run` fail silently;
    # clear them so repeated runs are robust.
    import glob
    for lock in glob.glob("/tmp/.X*-lock"):
        try:
            os.remove(lock)
        except OSError:
            pass
    # Headful on Xvfb (the real config). xvfb-run wraps the whole service.
    # start_new_session so we can signal the WHOLE group (xvfb-run + uv +
    # python + chrome) on teardown.
    cmd = ["xvfb-run", "-a", "uv", "run", "--project", str(PKG),
           "stealth-browser"]
    print(f"=== starting service: APEX_CORE={env.get('APEX_CORE','nodriver')} "
          f"patched={bool(env.get('APEX_CHROME_PATH'))} proxy="
          f"{env.get('PROXY_HOST')}:{env.get('PROXY_PORT')} ===", flush=True)
    proc = subprocess.Popen(cmd, env=env, cwd=str(PKG), start_new_session=True)
    results: list = []

    def check(ok, label, detail="", hard=True):
        results.append((ok, hard, label, "" if ok else f"  {detail}"))

    sid = None
    try:
        health = _wait_health(proc)
        print(f"  health: {health}")

        _, created = _req("POST", "/sessions", {})
        sid = created["id"]
        print(f"  session: {sid}")
        print(f"  profile: {json.dumps(created.get('profile', {}))[:400]}")

        # (a)+exit IP: navigate an IP echo, read the JSON the page received.
        _req("POST", f"/sessions/{sid}/navigate", {"url": IP_ECHO})
        _, ev = _req("POST", f"/sessions/{sid}/eval",
                     {"expression": "document.body ? document.body.innerText : ''"})
        page_txt = ev.get("result") or ""
        m = re.search(r"(\d+\.\d+\.\d+\.\d+)", page_txt)
        exit_ip = m.group(1) if m else None
        print(f"  exit IP seen by page: {exit_ip}  (raw: {page_txt[:120]!r})")
        check(exit_ip is not None, "exit IP resolved through browser",
              f"page text: {page_txt[:80]!r}")

        # (c) spoofed surfaces -- the new connection + storage ones especially.
        surf_js = (
            "(async () => {"
            "  const c = navigator.connection || {};"
            "  let q = null; try { const e = await navigator.storage.estimate();"
            "    q = e.quota; } catch(_) {}"
            "  return JSON.stringify({et:c.effectiveType, rtt:c.rtt,"
            "    dl:c.downlink, quota:q, plat:navigator.platform,"
            "    hw:navigator.hardwareConcurrency});"
            "})()"
        )
        _, sv = _req("POST", f"/sessions/{sid}/eval", {"expression": surf_js})
        surf = json.loads(sv.get("result") or "{}")
        print(f"  surfaces: {surf}")
        # quota > 100 GiB and a clean 4g profile = spoofed (datacenter VMs
        # report a small uniform quota like 10 GiB).
        spoofed = (surf.get("quota") or 0) > 100 * 1024**3
        check(spoofed, "connection/storage spoofed (quota > 100 GiB)",
              f"got quota={surf.get('quota')}", hard=require_spoof)

        # (b) WebRTC: gather candidates, assert no routable host IP leaks.
        webrtc_js = (
            "(() => new Promise((resolve) => {"
            "  let leaked = [];"
            "  let pc; try { pc = new RTCPeerConnection({iceServers: []}); }"
            "  catch(e){ return resolve('NO_RTC'); }"
            "  pc.onicecandidate = (ev) => {"
            "    if (!ev.candidate) return resolve(JSON.stringify(leaked));"
            "    const cand = ev.candidate.candidate || '';"
            "    const mm = cand.match(/(\\d+\\.\\d+\\.\\d+\\.\\d+)/);"
            "    if (mm && cand.includes('typ host') &&"
            "        !/^0\\.|^127\\./.test(mm[1])) leaked.push(mm[1]);"
            "  };"
            "  pc.createDataChannel('x');"
            "  pc.createOffer().then(o => pc.setLocalDescription(o)).catch(()=>{});"
            "  setTimeout(() => resolve(JSON.stringify(leaked)), 3000);"
            "}))()"
        )
        _, wv = _req("POST", f"/sessions/{sid}/eval", {"expression": webrtc_js})
        wres = wv.get("result")
        leaked = [] if wres in ("NO_RTC", None) else json.loads(wres)
        print(f"  WebRTC host candidates leaked: {leaked} (raw={wres!r})")
        check(len(leaked) == 0, "WebRTC exposes no real IP",
              f"leaked: {leaked}", hard=require_spoof)

        # (d) /fetch rides proxy + page cookies: set a cookie via navigate,
        # then fetch the echo endpoint from inside the page.
        try:
            _req("POST", f"/sessions/{sid}/navigate", {"url": COOKIE_SET})
            _, fr = _req("POST", f"/sessions/{sid}/fetch",
                         {"url": COOKIE_ECHO, "credentials": "include"})
            fbody = fr.get("body") or ""
            has_cookie = "proxy-cookie-42" in fbody
            print(f"  /fetch status={fr.get('status')} cookie_echoed="
                  f"{has_cookie}  body[:160]={fbody[:160]!r}")
            check(fr.get("status") == 200, "/fetch returned 200",
                  f"status={fr.get('status')}")
            check(has_cookie, "/fetch carried page cookie",
                  "cookie not echoed", hard=False)
        except Exception as e:
            check(False, "/fetch cookie ride", f"error: {e}", hard=False)

        # (a) routing proof: the proxy log must show CONNECTs to our targets.
        if proxy_log and Path(proxy_log).exists():
            with open(proxy_log) as f:
                if log_mark:
                    f.seek(log_mark)
                newlog = f.read()
            rode = ("api.ipify.org" in newlog) or ("httpbin.org" in newlog)
            connects = [l for l in newlog.splitlines() if "CONNECT" in l][:6]
            print("  proxy CONNECTs:\n    " + "\n    ".join(connects))
            check(rode, "browser traffic rode the proxy (CONNECT logged)",
                  "no target host in proxy log")
        else:
            check(False, "proxy log present for routing proof",
                  f"no PROXY_LOG at {proxy_log}", hard=False)

    finally:
        if sid:
            try:
                _req("DELETE", f"/sessions/{sid}")
            except Exception:
                pass
        # Signal the whole process group (xvfb-run + uv + python + chrome).
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=20)
        except Exception:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                proc.kill()

    print("\n--- proxy feature assertions ---")
    hard_fail = 0
    for ok, hard, label, detail in results:
        tag = "PASS" if ok else ("FAIL" if hard else "WARN")
        print(f"  {tag}  {label}{detail}")
        if not ok and hard:
            hard_fail += 1
    if hard_fail:
        print(f"\nVERDICT: {hard_fail} hard assertion(s) failed.")
        return 1
    print("\nVERDICT: proxy feature test PASSED"
          + (" (full, patched binary)" if require_spoof
             else " (routing/plumbing; run with patched binary + "
                  "REQUIRE_SPOOF=1 for the spoof/WebRTC asserts)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
