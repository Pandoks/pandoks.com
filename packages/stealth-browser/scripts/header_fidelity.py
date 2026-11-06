#!/usr/bin/env python3
"""HTTP header-fidelity test (JA4H): does the service path preserve the
browser's exact header ORDER and CONTENT?

Sends navigation requests and in-page fetch() calls through the stealth
service against a raw-socket echo server that logs the exact request bytes.
Compares:
  * nav-to-nav  -- Chrome's own navigation header order must be deterministic
                   and arrive byte-identical (nothing in the service path
                   reorders/normalizes).
  * fetch-to-fetch -- in-page fetch() headers must also be byte-identical.
  * browser vs fetch-plain -- /fetch-plain is a documented SERVER-SIDE tier
                   (curl_cffi); its stack is expected to differ and is
                   reported, not failed.

Verified findings (2026-11):
  * The browser path IS byte-for-byte clean: navigations and in-page fetch()
    arrive with Chrome's native header order and casing, identical across
    repeats; the service adds nothing and removes nothing. Over HTTPS the
    binary sends the full stock Chrome set (Sec-Ch-Ua / Sec-Ch-Ua-* /
    Sec-Fetch-* / br,zstd) in Chrome's natural order.
  * On plain HTTP (non-localhost) stock Chromium 157 omits the UA-CH /
    Sec-Fetch-* set and does not advertise br/zstd (scheme-gated in
    net/http/http_request_headers.cc) -- absence there is not a defect, so
    the required-header assertion is scheme-aware.
  * Requests that leave the browser (NOT the browser's fingerprint):
    /fetch-plain (curl_cffi tier) and proxy.lookup_exit_geo() (urllib IP-geo
    lookup run by the service when a proxy is configured). The MCP server
    only talks to the local HTTP service. All are documented in server.py /
    proxy.py and distinguishable from browser traffic by design.

Exit 0 = browser path is byte-for-byte clean. Prints every capture's header
list for the report.

Usage:
  python scripts/header_fidelity.py --base http://127.0.0.1:8089 \
    --target http://host.docker.internal:8099
  # with an https echo in front, --target https://... runs the full
  # Sec-* / UA-CH header assertion
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def api(base: str, method: str, path: str, body: dict | None = None,
        timeout: float = 180) -> tuple[int, object]:
    req = urllib.request.Request(base + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw[:1] in (b"{", b"[") else raw
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def parse_capture(raw_b64: str) -> dict:
    """Split a captured request into request line + header lines (exact)."""
    raw = base64.b64decode(raw_b64).decode("latin1")
    lines = raw.split("\r\n")
    request_line = lines[0]
    header_lines = []
    for ln in lines[1:]:
        if not ln:
            break
        header_lines.append(ln)
    return {"request_line": request_line, "headers": header_lines}


def header_names(capture: dict) -> list[str]:
    names = []
    for ln in capture["headers"]:
        name, _, _ = ln.partition(":")
        names.append(name)
    return names


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8089")
    ap.add_argument("--target", default="http://host.docker.internal:8099")
    ap.add_argument("--capture", default="/tmp/echo_requests.jsonl")
    ap.add_argument("--profile", default=None)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    cap_path = Path(args.capture)
    if cap_path.exists():
        cap_path.unlink()  # start clean; only this run's requests are read

    body = {"profile": args.profile} if args.profile else {}
    status, created = api(base, "POST", "/sessions", body=body)
    if status not in (200, 201) or not isinstance(created, dict):
        print(f"session create failed: {status} {created}", file=sys.stderr)
        return 2
    sid = created["id"]
    request_num = [0]

    failures: list[str] = []
    captures: dict[str, dict] = {}
    try:
        def read_new_captures() -> list[dict]:
            if not cap_path.exists():
                return []
            with open(cap_path) as f:
                lines = [l for l in f.read().splitlines() if l]
            return [json.loads(l) for l in lines[request_num[0]:]]

        def drain(tag: str, expect_sub: str) -> dict:
            """Wait for the next capture whose request line contains
            `expect_sub`, skipping non-matching requests (each page load also
            triggers a /favicon.ico fetch -- those are skipped, not labeled)."""
            skipped = 0
            for _ in range(60):
                pending = read_new_captures()
                for entry in pending:
                    request_num[0] += 1
                    line = base64.b64decode(entry["raw_b64"]).decode("latin1")
                    request_line = line.split("\r\n", 1)[0]
                    if expect_sub in request_line:
                        entry["tag"] = tag
                        entry["request_line"] = request_line
                        if skipped:
                            print(f"[skip] {skipped} non-target request(s) "
                                  f"(favicon etc.) before {tag}")
                        return entry
                    skipped += 1
                time.sleep(1)
            raise RuntimeError(f"no capture seen for {tag} ({expect_sub})")

        # 3 navigations -> nav1/nav2/nav3 (the page requests)
        for i in (1, 2, 3):
            status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                            body={"url": f"{args.target}/fp-page?i={i}"})
            if status != 200:
                raise RuntimeError(f"navigate {i} failed: {status}")
            captures[f"nav{i}"] = parse_capture(
                drain("nav", f"/fp-page?i={i}")["raw_b64"])
        # 2 in-page fetches -> fetch1/fetch2
        for i in (1, 2):
            status, _ = api(base, "POST", f"/sessions/{sid}/fetch",
                            body={"url": f"{args.target}/echo?i={i}",
                                  "method": "POST", "body": "hello"})
            if status != 200:
                raise RuntimeError(f"fetch {i} failed: {status}")
            captures[f"fetch{i}"] = parse_capture(
                drain("fetch", f"/echo?i={i}")["raw_b64"])
        # /fetch-plain -> the documented server-side tier
        status, plain = api(base, "POST", "/fetch-plain",
                            body={"url": f"{args.target}/echo?i=plain",
                                  "method": "POST", "body": "hello"})
        entries = [e for e in read_new_captures()
                   if "/echo?i=plain" in base64.b64decode(e["raw_b64"])
                   .decode("latin1").split("\r\n", 1)[0]]
        if entries:
            request_num[0] += 1
            captures["plain"] = parse_capture(entries[0]["raw_b64"])
        if status != 200 or not isinstance(plain, dict):
            failures.append(f"/fetch-plain failed: {status} {plain}")
    finally:
        api(base, "DELETE", f"/sessions/{sid}")

    # ---- report every capture's raw header list ----
    for name in ("nav1", "nav2", "nav3", "fetch1", "fetch2", "plain"):
        cap = captures.get(name)
        if not cap:
            failures.append(f"{name}: no request captured")
            continue
        print(f"\n=== {name} === {cap['request_line']}")
        for ln in cap["headers"]:
            print(f"  {ln}")

    # ---- byte-identical comparisons ----
    def path_of(cap: dict) -> str:
        # strip the query: the requests differ only in ?i=N tagging
        return cap["request_line"].split(" ", 2)[1].split("?", 1)[0]

    for a, b in (("nav1", "nav2"), ("nav2", "nav3"),
                 ("fetch1", "fetch2")):
        if a not in captures or b not in captures:
            continue
        if path_of(captures[a]) != path_of(captures[b]):
            failures.append(f"{a} vs {b}: different request targets (test bug)")
        if captures[a]["headers"] != captures[b]["headers"]:
            failures.append(f"{a} vs {b}: header list differs byte-for-byte")
        else:
            print(f"\n[OK] {a} == {b} (byte-identical header order/content)")

    # ---- browser-native header presence on the navigation path ----
    # Scheme-conditional: upstream Chromium 157 emits the UA-CH + Sec-Fetch-*
    # set (and advertises br/zstd) only on cryptographic/localhost targets
    # (http_request_headers.cc SetAcceptEncodingIfMissing; same gating for the
    # Sec- metadata). Verified against the binary over HTTPS: the full set is
    # present. On plain http a target the Sec-* / sec-ch-ua set is legitimately
    # absent for stock Chrome too, so only require it for https.
    nav = captures.get("nav1")
    if nav:
        is_https = args.target.startswith("https://")
        names = [n.lower() for n in header_names(nav)]
        base_required = ["host", "user-agent", "accept", "accept-encoding",
                         "accept-language", "upgrade-insecure-requests"]
        https_required = ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
                          "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
                          "sec-fetch-user"]
        required = base_required + (https_required if is_https else [])
        missing = [h for h in required if h not in names]
        if missing:
            failures.append(f"navigation missing browser-native headers: "
                            f"{missing}")
        if not is_https:
            print("[INFO] plain-http target: stock Chromium omits the UA-CH / "
                  "Sec-Fetch-* set and br/zstd there (scheme-gated) -- the "
                  "absence is not a fidelity defect.")

    if captures.get("plain"):
        print("\n[INFO] /fetch-plain is the SERVER-SIDE curl_cffi tier; its "
              "TLS/header stack is intentionally its own (documented).")
    if failures:
        print(f"\nHEADER FIDELITY: {len(failures)} finding(s)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nHEADER FIDELITY: browser path byte-for-byte clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
