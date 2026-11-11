#!/usr/bin/env python3
"""Interactive captcha-flow tier for the stealth-browser battery.

adversarial.py's other tiers prove the fingerprint is invisible; this tier
proves the browser can actually SOLVE interactive challenges end-to-end
through the humanized input layer. Each flow drives a real captcha and passes
only when the page itself yields a token:

  - clicks go through POST /sessions/:id/click, which routes into the
    humanizer (min-jerk pointer path + press-hold-release) -- never a raw CDP
    dispatch.
  - each flow is bounded (TOKEN_TIMEOUT_S), tolerant of late-loading widgets
    (the challenge frame is polled, not awaited), and tears its session down
    in a finally block exactly like the rest of the battery.

  flow                      surface                  pass criterion
  ------------------------  -----------------------  -------------------------
  cloudflare-turnstile      demo.turnstile.workers.  non-empty
                            dev (official demo)      cf-turnstile-response
  recaptcha-v3              local fixture, Google's  non-empty token in #token
                            always-pass TEST sitekey
  hcaptcha                  local fixture, hCaptcha  non-empty token in #token
                            always-pass TEST sitekey

Local fixtures are served by a stdlib http.server and the URL the BROWSER can
reach is resolved by probing candidate bases through the service's own /fetch
endpoint (the service runs in a container, so 127.0.0.1 on the battery host is
not automatically the same host from the browser's perspective).

Run: python scripts/flow_targets.py --base http://localhost:41000
"""

from __future__ import annotations

import json
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN_TIMEOUT_S = 90        # bounded wait for a token per flow
TOKEN_GRACE_S = 15          # wait this long for an auto-pass before clicking
TOKEN_POLL_INTERVAL_S = 3

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
FIXTURE_PROBE_FILE = "recaptcha_v3.html"
FIXTURE_PROBE_NEEDLES = ("grecaptcha",)

# Click candidates for the widget-internal checkbox. `>>` pierces iframes and
# lands the humanized click at main-frame viewport coordinates; order is
# generic-first so a missing checkbox just falls through to the next try.
TURNSTILE_CLICK_SELECTORS = [
    'iframe[src*="challenges.cloudflare.com"] >> input[type="checkbox"]',
    'iframe[src*="challenges.cloudflare.com"] >> [role="checkbox"]',
]
HCAPTCHA_CLICK_SELECTORS = [
    'iframe[src*="hcaptcha.com"] >> [role="checkbox"]',
    'iframe[src*="hcaptcha.com"] >> input[type="checkbox"]',
]

# The uniform pass-criterion probe. Every flow is scored by whether ANY token
# source became non-empty, so one parser scores all three flows. `>>`-pierce
# aside, we deliberately evaluate only the TOP frame: Turnstile/reCAPTCHA/
# hCaptcha all surface the token to the host page (hidden response input or
# the callback we wire into #token).
TOKEN_EXTRACT_JS = """(() => {
  const out = {tokens: [], state: null};
  for (const sel of [
      '[name="cf-turnstile-response"]',
      '[name="g-recaptcha-response"]',
      '[name="h-captcha-response"]']) {
    for (const el of document.querySelectorAll(sel)) {
      const v = el.value || '';
      if (v.trim()) out.tokens.push(v.trim().slice(0, 64));
    }
  }
  const tok = document.getElementById('token');
  if (tok && tok.textContent && tok.textContent.trim()) {
    out.tokens.push(tok.textContent.trim().slice(0, 64));
  }
  const st = document.getElementById('state');
  if (st) out.state = st.textContent.trim();
  return JSON.stringify(out);
})()"""

FIXTURE_TARGETS = {
    "recaptcha-v3": "recaptcha_v3.html",
    "hcaptcha": "hcaptcha.html",
}


def parse_token_result(raw) -> dict:
    """Normalize a /eval result into {tokens, state, parse_error}. Pure.

    The result arrives either as the JSON string our probe returns or as an
    already-deserialized dict (server-side behavior can vary by backend).
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {"tokens": [], "state": None, "parse_error": "not json"}
    if not isinstance(raw, dict):
        return {"tokens": [], "state": None, "parse_error": "not a dict"}
    tokens = [t for t in raw.get("tokens") or []
              if isinstance(t, str) and t.strip()]
    state = raw.get("state")
    return {"tokens": tokens,
            "state": state if isinstance(state, str) else None,
            "parse_error": None}


def flow_passes(result: dict) -> tuple[bool, str]:
    """The pass criterion: at least one non-empty token. Pure."""
    if not isinstance(result, dict):
        return False, f"unparseable result: {result!r}"
    if result.get("parse_error"):
        return False, f"extraction failed ({result['parse_error']})"
    if result.get("tokens"):
        return True, f"token present ({len(result['tokens'])} token(s))"
    return False, f"no token (state={result.get('state')!r})"


def _primary_ip() -> str | None:
    """Best-effort primary interface address (for bridge-network containers)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("1.1.1.1", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def _fixture_base_candidates(port: int) -> list[str]:
    cands = [f"http://host.docker.internal:{port}",
             f"http://127.0.0.1:{port}",
             f"http://[::1]:{port}"]
    ip = _primary_ip()
    if ip:
        cands.append(f"http://{ip}:{port}")
    cands.append(f"http://172.17.0.1:{port}")
    seen, out = set(), []
    for c in cands:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: A002 - stdlib signature
        pass


def start_fixture_server() -> tuple[int, ThreadingHTTPServer]:
    """Serve FIXTURE_DIR on an ephemeral port bound to all interfaces."""
    handler = partial(_QuietHandler, directory=str(FIXTURE_DIR))
    server = ThreadingHTTPServer(("0.0.0.0", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1], server


def resolve_fixture_base(base: str, port: int, api) -> str | None:
    """Find the fixture URL the browser can actually reach, via the service.

    Probing through /sessions/:id/fetch means the request comes FROM the
    browser's network position, which is the only position that matters.
    """
    status, created = api(base, "POST", "/sessions", body={})
    if status not in (200, 201) or not isinstance(created, dict):
        return None
    sid = created["id"]
    try:
        for cand in _fixture_base_candidates(port):
            try:
                status, res = api(
                    base, "POST", f"/sessions/{sid}/fetch",
                    body={"url": f"{cand}/{FIXTURE_PROBE_FILE}",
                          "timeout_ms": 3000})
            except (ConnectionError, TimeoutError):
                continue
            if (status == 200 and isinstance(res, dict)
                    and any(n in str(res.get("body", ""))
                            for n in FIXTURE_PROBE_NEEDLES)):
                return cand
        return None
    finally:
        api(base, "DELETE", f"/sessions/{sid}")


def run_flow(base: str, name: str, url: str, click_selectors: list[str],
             api) -> dict:
    """One flow: create session -> navigate -> poll for token -> cleanup.

    The humanizer click happens once, at the grace deadline, so a widget that
    solves itself is never disturbed mid-solve and an interactive one still
    gets exactly one natural click attempt.
    """
    status, created = api(base, "POST", "/sessions", body={})
    if status not in (200, 201) or not isinstance(created, dict):
        return {"name": name, "error": f"session create failed: {status}"}
    sid = created["id"]
    try:
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": url})
        if status != 200:
            return {"name": name, "outcome": f"navigate-failed ({status})"}
        clicked = False
        last = "never probed"
        deadline = time.monotonic() + TOKEN_TIMEOUT_S
        grace = time.monotonic() + TOKEN_GRACE_S
        while time.monotonic() < deadline:
            status, ev = api(base, "POST", f"/sessions/{sid}/eval",
                             body={"expression": TOKEN_EXTRACT_JS})
            if status == 200 and isinstance(ev, dict):
                ok, last = flow_passes(parse_token_result(ev.get("result")))
                if ok:
                    return {"name": name, "outcome": f"solved ({last})"}
            if not clicked and time.monotonic() >= grace:
                clicked = True
                for sel in click_selectors:
                    try:
                        status, _ = api(base, "POST", f"/sessions/{sid}/click",
                                        body={"selector": sel}, timeout=180)
                    except (ConnectionError, TimeoutError):
                        status = 0
                    if status == 200:
                        # click landed; a human waits for the challenge to
                        # settle instead of double-clicking every candidate
                        break
            time.sleep(TOKEN_POLL_INTERVAL_S)
        # one final probe at the deadline; a click landing right at the end
        # shouldn't be missed by the poll interval
        status, ev = api(base, "POST", f"/sessions/{sid}/eval",
                         body={"expression": TOKEN_EXTRACT_JS})
        if status == 200 and isinstance(ev, dict):
            ok, last = flow_passes(parse_token_result(ev.get("result")))
            if ok:
                return {"name": name, "outcome": f"solved ({last})"}
        clicks = "1 click attempt" if clicked else "no click attempted"
        return {"name": name, "outcome": f"unsolved after {TOKEN_TIMEOUT_S}s "
                                         f"({last}, {clicks})"}
    finally:
        api(base, "DELETE", f"/sessions/{sid}")


# (name, url-or-fixture, click candidates at the grace deadline). A fixture
# flow's URL is filled in by run_flows once the reachable base is known.
FLOW_TARGETS = [
    ("cloudflare-turnstile", "https://demo.turnstile.workers.dev/",
     TURNSTILE_CLICK_SELECTORS),
    ("recaptcha-v3", ("fixture", "recaptcha_v3.html"), []),
    ("hcaptcha", ("fixture", "hcaptcha.html"), HCAPTCHA_CLICK_SELECTORS),
]


def run_flows(base: str, api) -> tuple[list[dict], list[str]]:
    """Run every flow target. Returns (results, failure reasons)."""
    results: list[dict] = []
    failures: list[str] = []
    server = None
    fixture_base = None
    try:
        needs_fixture = any(isinstance(spec[1], tuple) for spec in FLOW_TARGETS)
        if needs_fixture:
            _, server = start_fixture_server()
            fixture_base = resolve_fixture_base(base, server.server_port, api)
            if fixture_base is None:
                for name, spec, _ in FLOW_TARGETS:
                    if isinstance(spec, tuple):
                        results.append({"name": name, "outcome":
                                        "no reachable fixture base from the "
                                        "browser (no candidate URL answered)"})
                failures.extend(f"flows:{r['name']}: {r['outcome']}"
                                for r in results)
                return results, failures
        for name, spec, selectors in FLOW_TARGETS:
            if isinstance(spec, tuple):
                url = f"{fixture_base}/{spec[1]}"
            else:
                url = spec
            r = run_flow(base, name, url, selectors, api)
            results.append(r)
            outcome = r.get("outcome", r.get("error", "unknown"))
            if not outcome.startswith("solved"):
                failures.append(f"flows:{name}: {outcome}")
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
    return results, failures


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:41000")
    ap.add_argument("--wait", type=int, default=60)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from adversarial import api, wait_health  # noqa: E402
    if not wait_health(base, args.wait):
        print(f"service at {base} never reported healthy", file=sys.stderr)
        return 2
    results, failures = run_flows(base, api)
    for r in results:
        outcome = r.get("outcome", r.get("error", "unknown"))
        mark = "PASS" if outcome.startswith("solved") else "FAIL"
        print(f"  [{mark}] {r['name']}: {outcome}")
    print()
    print(f"CAPTCHA FLOWS: {len(failures)} unsolved")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
