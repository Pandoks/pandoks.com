#!/usr/bin/env python3
"""Adversarial detection/avoidance harness for the stealth browser stack.

Drives one or more sessions through the service HTTP API and measures how a
detection model sees them:

  1. local detector battery   -- checks.py's PROBE_JS (the cheap, decisive
     signals a fingerprinter checks first: webdriver, headless UA, CDP leak,
     WebGL/canvas, window dims, ...)
  2. CreepJS cross-check      -- the strictest public fingerprint auditor;
     we want headless 0% / stealth 0%.
  3. hard-target probes       -- the anti-bot vendors (Cloudflare, DataDome,
     Akamai, Kasada, HUMAN, Amazon). We navigate each and classify whether we
     got a challenge, a block, or the real page.
  4. captcha flows            -- interactive challenges (Turnstile, reCAPTCHA
     v3, hCaptcha) driven to a SOLVED state through the humanized input layer;
     every click goes through the humanizer, never a raw CDP dispatch.

Every target gets its own session, driven exactly as an automation client
would drive it. The matrix at the end is the "what can the model still see"
answer; a clean run is exit 0. Run it in a loop -- any failure is the next
thing to patch.

Usage:
  python scripts/adversarial.py --base http://localhost:41000
  python scripts/adversarial.py --base http://localhost:41000 --targets hard
  python scripts/adversarial.py --base http://localhost:41000 --targets flows
  python scripts/adversarial.py --base http://localhost:41000 --local
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from stealth_browser import checks  # noqa: E402
from stealth_browser import creepjs  # noqa: E402

# Challenge markers for the hard targets. A site passes when NONE of its
# vendor's markers appear in the rendered text. Detector TEST pages that
# always render their own check names need a custom check instead -- raw
# markers false-positive on the page's static UI (sannysoft prints
# "webdriver" 40x as row labels on a clean pass; rebrowser's UI renders
# "detected"/"not detected" as its own vocabulary).

def _sannysoft_hit(text: str) -> str | None:
    # sannysoft renders every check name as a row label regardless of
    # outcome, and its detailed JSON dump contains keys like
    # `"webDriver": true` meaning "the property EXISTS" (value is false).
    # So only table rows at line start count: a real fail shows the
    # anomalous value ("true"/"missing") as the row's value; passing rows
    # show "passed"/"missing (passed)". Skip anything that looks like the
    # indented JSON metadata block.
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('"') or s.startswith('{') or s.startswith('}'):
            continue
        low = s.lower()
        if not any(k in low for k in ("webdriver", "headless", "chrome driver",
                                      "browser is being controlled")):
            continue
        if "browser is being controlled" in low:
            return "controlled-banner"
        # row = "CheckName<TAB or spaces>value"; value "passed" or
        # "missing (passed)" == pass; anything else = the detected value
        if re.search(r'\b(true|found|detected)\b\s*$', low):
            return s[:60]
    return None


def _rebrowser_hit(text: str) -> str | None:
    # the page renders one glyph per test: green pass, yellow warning,
    # red fail -- and uses the words "detected"/"not detected" inside PASS
    # messages ("No leak detected"), so word matching is meaningless.
    # Fail on any yellow/red test line; report the test name.
    for line in text.splitlines():
        s = line.strip()
        if s.startswith(("🟡", "🔴")):
            return s[:60]
    return None


HARD_TARGETS = [
    # public detector pages (from the 2025-26 gap research: docs/detection-gaps.md)
    ("sannysoft", "https://bot.sannysoft.com/", [], _sannysoft_hit),
    ("rebrowser", "https://bot-detector.rebrowser.net/", [], _rebrowser_hit),
    ("creepbot", "https://abrahamjuliot.github.io/creepjs/tests/detect.html", [
        "headless", "detected"], None),
    ("fingerprint-demo", "https://demo.fingerprint.com/playground", [
        "bot detected", "bot score"]),
    # hard-target vendor sites
    ("cloudflare", "https://www.cloudflare.com/", [
        "just a moment", "checking your browser", "enable javascript and cookies",
        "attention required", "challenge-platform"]),
    ("datadome", "https://datadome.co/", [
        "datadome challenge", "captcha-delivery", "verify you are human"]),
    # no "blocked" marker: the vendor's own marketing copy legitimately
    # contains it, so a clean visit would false-FAIL; the challenge markers
    # above are the specific signals
    ("akamai", "https://www.akamai.com/", [
        "access denied", "reference number", "transaction id", "bot manager"]),
    ("kasada", "https://kasada.io/", [
        "access denied", "blocked", "challenge"]),
    ("human", "https://www.humansecurity.com/", [
        "access denied", "press & hold", "human verification"]),
    ("amazon", "https://www.amazon.com/", [
        "type the characters you see", "enter the characters", "robot check",
        "automated access"]),
]

CHALLENGE_TIMEOUT_S = 75  # challenge pages resolve in a loop; give them time


def as_expression(fn_js: str) -> str:
    """checks.PROBE_JS / creepjs.EXTRACT_JS are arrow functions `() => {...}`.

    /eval runs a JS *expression* (Runtime.evaluate), so a bare arrow function
    evaluates to the function itself and comes back as `{}` -- every check
    then scores on missing keys. Wrap it in an immediately-invoked call.
    """
    return f"({fn_js.strip()})()"


def api(base: str, method: str, path: str, body: dict | None = None,
        timeout: float = 120) -> tuple[int, dict | bytes]:
    req = urllib.request.Request(base + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    else:
        data = None
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")
        except (ConnectionError, TimeoutError) as e:
            # transient resets/timeouts kill the whole battery otherwise
            last = e
            time.sleep(2 * (attempt + 1))
    raise last  # type: ignore[misc]


def wait_health(base: str, limit_s: int = 60) -> bool:
    for _ in range(limit_s // 3):
        try:
            status, body = api(base, "GET", "/health", timeout=5)
            if status == 200 and isinstance(body, dict) and body.get("ok"):
                return True
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(3)
    return False


TLS_ECHO_URL = "https://tls.peet.ws/api/all"


def _fetch_tls_via_navigation(api, base: str, sid: str) -> dict:
    """Read the TLS echo endpoint by NAVIGATING to it (fetch() from a page is
    CORS-blocked: tls.peet.ws sends no Access-Control-Allow-Origin; a direct
    navigation has no CORS).  Returns the parsed JSON response or {}."""
    try:
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": TLS_ECHO_URL})
        if status != 200:
            return {}
        time.sleep(4)
        status, txt = api(base, "GET", f"/sessions/{sid}/text")
        body = (txt or {}).get("text", "") if isinstance(txt, dict) else ""
        return json.loads(body) if str(body).strip().startswith("{") else {}
    except Exception as e:  # noqa: BLE001 - report as empty, not fatal
        return {"_tls_fetch_error": str(e)}


def _merge_tls_scoring(probe: dict, tls: dict) -> None:
    """Compute the TLS-surface checks from server-observed data. The probe
    fields (tlsJa3 etc.) are filled here because the JS probe no longer does
    the fetch (CORS)."""
    tls_info = tls.get("tls") or {}
    probe["tlsJa3"] = tls_info.get("ja3")
    probe["tlsJa3Hash"] = tls_info.get("ja3_hash")
    probe["tlsJa4"] = tls_info.get("ja4")
    probe["tlsJa4R"] = tls_info.get("ja4_r")
    probe["tlsHttpVersion"] = tls.get("http_version")
    probe["tlsServerUa"] = tls.get("user_agent")
    probe["tlsMethod"] = tls.get("method")
    headers = []
    for frame in (tls.get("http2") or {}).get("sent_frames") or []:
        if isinstance(frame, dict) and frame.get("frame_type") == "HEADERS":
            headers = frame.get("headers") or []
            break
    probe["tlsRequestHeaders"] = headers
    header_map = {}
    for h in headers:
        if isinstance(h, str) and ": " in h:
            k, v = h.split(": ", 1)
            header_map[k.lower()] = v
    probe["tlsAcceptLanguage"] = header_map.get("accept-language")
    probe["tlsAutomationHeaders"] = [k for k in header_map
                                     if re.match(r"^x-(cdp|pw|playwright|puppeteer|webdriver|selenium|nodriver|chrome)",
                                                 k, re.I)]
    probe["tlsUaMismatch"] = bool(probe["tlsServerUa"]
                                  and probe["tlsServerUa"] != probe.get("userAgent"))
    first_lang = ((probe.get("languages") or [None])[0] or "").lower()
    probe["tlsAcceptLanguageOk"] = (not headers
                                    or (probe["tlsAcceptLanguage"] is not None
                                        and first_lang
                                        and probe["tlsAcceptLanguage"].lower().startswith(first_lang)))
    # Sec-Fetch-* request metadata (detection-gaps row 24). The battery's TLS
    # check navigates top-level, so the coherent set is site=none (no
    # initiator), mode=navigate, dest=document, user=?1. All four must be
    # present whenever headers were observable; a header-less run passes
    # (same convention as tlsAcceptLanguageOk).
    probe["tlsSecFetch"] = {k: header_map.get("sec-fetch-" + k)
                            for k in ("site", "mode", "dest", "user")}
    probe["tlsSecFetchObserved"] = bool(headers)
    sec_fetch = probe["tlsSecFetch"]
    probe["tlsSecFetchOk"] = (not headers
                              or (all(sec_fetch[k] is not None
                                      for k in ("site", "mode", "dest", "user"))
                                  and sec_fetch["mode"] == "navigate"
                                  and sec_fetch["dest"] == "document"
                                  and sec_fetch["site"] == "none"
                                  and sec_fetch["user"] == "?1"))
    probe["tlsSurfaceOk"] = (bool(probe["tlsJa3"] and probe["tlsJa3Hash"]
                                  and probe["tlsJa4"] and probe["tlsJa4R"])
                             and probe["tlsUaMismatch"] is False
                             and probe["tlsAcceptLanguageOk"] is True
                             and not probe["tlsAutomationHeaders"]
                             and probe["tlsSecFetchOk"] is True)


def run_local_battery(base: str, name: str, probe_js: str) -> dict:
    """Create a session, run the probe JS on it, score, clean up."""
    status, created = api(base, "POST", "/sessions", body={})
    if status not in (200, 201) or not isinstance(created, dict):
        return {"name": name, "error": f"session create failed: {status}"}
    sid = created["id"]
    try:
        status, nav = api(base, "POST", f"/sessions/{sid}/navigate",
                          body={"url": "https://example.com/"})
        if status != 200:
            return {"name": name, "error": f"navigate failed: {status} {nav}"}
        status, ev = api(base, "POST", f"/sessions/{sid}/eval",
                         body={"expression": probe_js})
        if status != 200 or not isinstance(ev, dict):
            return {"name": name, "error": f"eval failed: {status} {ev}"}
        result = ev.get("result")
        probe = json.loads(result) if isinstance(result, str) else result
        if not isinstance(probe, dict):
            return {"name": name, "error": f"probe not a dict: {probe!r}"}
        _merge_tls_scoring(probe, _fetch_tls_via_navigation(api, base, sid))
        return {"name": name, "probe": probe, "scored": checks.score(probe)}
    finally:
        api(base, "DELETE", f"/sessions/{sid}")


def probe_hard_target(base: str, name: str, url: str, markers: list[str],
                      custom_check=None) -> dict:
    status, created = api(base, "POST", "/sessions", body={})
    if status not in (200, 201) or not isinstance(created, dict):
        return {"name": name, "error": f"session create failed: {status}"}
    sid = created["id"]
    try:
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate", body={"url": url})
        if status != 200:
            return {"name": name, "outcome": "navigate-failed"}
        # sample the rendered text a few times (challenge pages settle late)
        verdict = "clean"
        for _ in range(3):
            time.sleep(5)
            status, txt = api(base, "GET", f"/sessions/{sid}/text")
            body = (txt or {}).get("text", "") if isinstance(txt, dict) else ""
            low = str(body).lower()
            if custom_check is not None:
                hit = custom_check(str(body))
            else:
                hit = next((m for m in markers if m in low), None)
            if hit:
                verdict = f"challenged ({hit})"
                break
        else:
            verdict = "clean"
        return {"name": name, "outcome": verdict}
    finally:
        api(base, "DELETE", f"/sessions/{sid}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:41000")
    ap.add_argument("--targets", choices=["local", "creep", "hard", "flows",
                                           "all"], default="all")
    ap.add_argument("--wait", type=int, default=60, help="seconds to wait for /health")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    if not wait_health(base, args.wait):
        print(f"service at {base} never reported healthy", file=sys.stderr)
        return 2

    failures: list[str] = []

    if args.targets in ("local", "all"):
        r = run_local_battery(base, "local-battery",
                              as_expression(checks.PROBE_JS))
        if "scored" not in r:
            print(r, file=sys.stderr)
            failures.append("local-battery: could not run")
        else:
            print(checks.format_report("local-battery", r["scored"]))
            if r["scored"]["failures"]:
                failures.extend(f"local: {f}" for f in r["scored"]["failures"])

    if args.targets in ("creep", "all"):
        status, created = api(base, "POST", "/sessions", body={})
        sid = created["id"] if status in (200, 201) and isinstance(created, dict) else None
        if not sid:
            failures.append("creep: session create failed")
        else:
            try:
                api(base, "POST", f"/sessions/{sid}/navigate",
                    body={"url": creepjs.CREEPJS_URL})
                # CreepJS computes asynchronously; poll until the verdict lands
                for _ in range(10):
                    time.sleep(5)
                    status, ev = api(base, "POST", f"/sessions/{sid}/eval",
                                     body={"expression":
                                           as_expression(creepjs.EXTRACT_JS)})
                    res = ev.get("result") if status == 200 else None
                    creep = json.loads(res) if isinstance(res, str) else res
                    if isinstance(creep, dict) and creep.get("ready"):
                        break
                if isinstance(creep, dict) and creep.get("ready"):
                    print(creepjs.summarize(creep))
                    if not creepjs.creep_passes(creep):
                        failures.append("creep: headless/stealth > 0")
                else:
                    failures.append("creep: page never produced a verdict")
            finally:
                api(base, "DELETE", f"/sessions/{sid}")

    if args.targets in ("hard", "all"):
        print("\n=== hard targets ===")
        for name, url, markers, *rest in HARD_TARGETS:
            custom = rest[0] if rest else None
            r = probe_hard_target(base, name, url, markers, custom)
            outcome = r.get("outcome", r.get("error", "unknown"))
            mark = "PASS" if outcome == "clean" else "FAIL"
            print(f"  [{mark}] {name}: {outcome}")
            if outcome != "clean":
                failures.append(f"hard:{name}: {outcome}")

    if args.targets in ("flows", "all"):
        # imported here so the rest of the battery doesn't pull the flow
        # machinery in on every run
        import flow_targets
        print("\n=== captcha flows ===")
        try:
            results, flow_failures = flow_targets.run_flows(base, api)
        except Exception as e:  # noqa: BLE001 - a crashed tier is a finding
            results, flow_failures = [], [f"flows: crashed: {e}"]
        for r in results:
            outcome = r.get("outcome", r.get("error", "unknown"))
            mark = "PASS" if outcome.startswith("solved") else "FAIL"
            print(f"  [{mark}] {r['name']}: {outcome}")
        failures.extend(flow_failures)

    print()
    if failures:
        print(f"DETECTION SURFACE: {len(failures)} finding(s)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("DETECTION SURFACE: clean -- nothing visible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
