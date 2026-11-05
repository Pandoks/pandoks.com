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

Every target gets its own session, driven exactly as an automation client
would drive it. The matrix at the end is the "what can the model still see"
answer; a clean run is exit 0. Run it in a loop -- any failure is the next
thing to patch.

Usage:
  python scripts/adversarial.py --base http://localhost:41000
  python scripts/adversarial.py --base http://localhost:41000 --targets hard
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
# vendor's markers appear in the rendered text.
HARD_TARGETS = [
    # public detector pages (from the 2025-26 gap research: docs/detection-gaps.md)
    ("sannysoft", "https://bot.sannysoft.com/", [
        "chrome driver", "webdriver", "headless", "browser is being controlled"]),
    ("rebrowser", "https://bot-detector.rebrowser.net/", [
        "detected", "webdriver"]),
    ("creepbot", "https://abrahamjuliot.github.io/creepjs/tests/detect.html", [
        "headless", "detected"]),
    ("fingerprint-demo", "https://demo.fingerprint.com/playground", [
        "bot detected", "bot score"]),
    # hard-target vendor sites
    ("cloudflare", "https://www.cloudflare.com/", [
        "just a moment", "checking your browser", "enable javascript and cookies",
        "attention required", "challenge-platform"]),
    ("datadome", "https://datadome.co/", [
        "datadome challenge", "captcha-delivery", "verify you are human",
        "blocked"]),  # careful: vendor's own page legitimately contains its name
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


def api(base: str, method: str, path: str, body: dict | None = None,
        timeout: float = 120) -> tuple[int, dict | bytes]:
    req = urllib.request.Request(base + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    else:
        data = None
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def wait_health(base: str, limit_s: int = 60) -> bool:
    for _ in range(limit_s // 3):
        try:
            status, body = api(base, "GET", "/health", timeout=5)
            if status == 200 and isinstance(body, dict) and body.get("ok"):
                return True
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(3)
    return False


def run_local_battery(base: str, name: str, probe_js: str) -> dict:
    """Create a session, run the probe JS on it, score, clean up."""
    status, created = api(base, "POST", "/sessions", body={})
    if status != 200 or not isinstance(created, dict):
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
        return {"name": name, "probe": probe, "scored": checks.score(probe)}
    finally:
        api(base, "DELETE", f"/sessions/{sid}")


def probe_hard_target(base: str, name: str, url: str, markers: list[str]) -> dict:
    status, created = api(base, "POST", "/sessions", body={})
    if status != 200 or not isinstance(created, dict):
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
    ap.add_argument("--targets", choices=["local", "creep", "hard", "all"],
                    default="all")
    ap.add_argument("--wait", type=int, default=60, help="seconds to wait for /health")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    if not wait_health(base, args.wait):
        print(f"service at {base} never reported healthy", file=sys.stderr)
        return 2

    failures: list[str] = []

    if args.targets in ("local", "all"):
        r = run_local_battery(base, "local-battery", checks.PROBE_JS)
        if "scored" not in r:
            print(r, file=sys.stderr)
            failures.append("local-battery: could not run")
        else:
            print(checks.format_report("local-battery", r["scored"]))
            if r["scored"]["failures"]:
                failures.extend(f"local: {f}" for f in r["scored"]["failures"])

    if args.targets in ("creep", "all"):
        status, created = api(base, "POST", "/sessions", body={})
        sid = created["id"] if status == 200 and isinstance(created, dict) else None
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
                                     body={"expression": creepjs.EXTRACT_JS})
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
        for name, url, markers in HARD_TARGETS:
            r = probe_hard_target(base, name, url, markers)
            outcome = r.get("outcome", r.get("error", "unknown"))
            mark = "PASS" if outcome == "clean" else "FAIL"
            print(f"  [{mark}] {name}: {outcome}")
            if outcome != "clean":
                failures.append(f"hard:{name}: {outcome}")

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
