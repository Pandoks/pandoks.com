#!/usr/bin/env python3
"""Acceptance probe -- network gate + enterprise targets + storage isolation.

Drives the PRODUCTION launch path (core_nodriver.NodriverCore: patched binary,
persona profile dir, ProxyForwarder, exit-IP identity coherence) so all three
checks observe exactly what ships -- no bespoke launch flags.

  1. NETWORK ACCEPTANCE GATE -- tls.peet.ws/api/all through the residential
     proxy. The ProxyForwarder CONNECT-tunnels, so Chrome's own TLS/HTTP2
     handshake reaches the target untouched. Confirms the exiting JA3/JA4/
     Akamai-H2 fingerprint is authentic Chrome (a TLS-terminating MITM proxy
     would replace it -- the whole reason for the tunnelling forwarder).
  2. ENTERPRISE LIVE TARGETS -- load real anti-bot-fronted pages, run
     behavioral activity, capture the verdict (ok / challenged / blocked) and a
     screenshot. Read-only homepage/detector GETs only.
  3. CROSS-PROFILE STORAGE ISOLATION -- write cookie + localStorage + IndexedDB
     as persona A, reopen as persona B, confirm B sees none of A's state (and a
     reopened A still does -- a positive control that the dirs are real).

Artifacts -> /tmp/acceptance/ (JSON + PNG). The wrapper uploads to S3.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "stealth-browser"))

from stealth_browser.core_nodriver import NodriverCore  # noqa: E402

OUT = Path("/tmp/acceptance")
OUT.mkdir(parents=True, exist_ok=True)

# Chrome's stable HTTP/2 SETTINGS/window/priority fingerprint (Akamai form).
# Recent Chrome desktop stable. We REPORT + compare rather than hard-pin, since
# the exact value shifts across majors -- a mismatch is a REVIEW flag, not an
# automatic fail (the structural checks below are the real gate).
CHROME_AKAMAI_H2 = "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p"

# Enterprise / scoring targets. Read-only loads of public detector + homepage
# endpoints. Override with APEX_ACCEPT_TARGETS="name=url,name=url".
ENTERPRISE_TARGETS = [
    ("incolumitas", "https://bot.incolumitas.com/"),
    ("fingerprint", "https://fingerprint.com/products/bot-detection/"),
    ("datadome", "https://datadome.co/"),
    ("cloudflare", "https://nowsecure.nl/"),
]

# Heuristic block/challenge markers (lowercased innerText scan).
BLOCK_MARKERS = (
    "access denied", "you have been blocked", "are you a robot",
    "verify you are human", "verifying you are human", "checking your browser",
    "unusual traffic", "captcha", "cf-error", "request blocked",
    "enable javascript and cookies", "ddos protection by", "ray id",
)


def _targets() -> list[tuple[str, str]]:
    raw = os.environ.get("APEX_ACCEPT_TARGETS", "").strip()
    if not raw:
        return ENTERPRISE_TARGETS
    out = []
    for item in raw.split(","):
        if "=" in item:
            name, url = item.split("=", 1)
            out.append((name.strip(), url.strip()))
    return out or ENTERPRISE_TARGETS


async def _shot(core: NodriverCore, name: str) -> None:
    try:
        png = await core.screenshot()
        if png:
            (OUT / f"{name}.png").write_bytes(png)
    except Exception as e:  # noqa: BLE001
        print(f"  ({name} screenshot failed: {str(e)[:60]})")


async def network_gate() -> dict:
    """Drive the patched binary through the proxy to tls.peet.ws/api/all."""
    print("=== [1/3] network acceptance gate (tls.peet.ws via proxy) ===")
    core = NodriverCore(headless=False, use_proxy=True)
    res: dict = {"check": "network_gate"}
    try:
        await core.open()
        prof = core.profile
        res["proxy_active"] = prof["proxy"]["active"]
        res["exit_geo"] = prof["proxy"]["exit_geo"]
        res["persona_ua_platform"] = prof["fingerprint"]["device_profile"]
        # Load the origin's HTML page, then fetch the JSON same-origin -- the
        # fetch rides Chrome's own network stack (identical TLS/H2 fingerprint)
        # and returns clean JSON, avoiding Chrome's JSON-viewer DOM ambiguity.
        await core.navigate("https://tls.peet.ws/")
        await asyncio.sleep(1)
        raw = await core.eval_js(
            "(async()=>{try{const r=await fetch('/api/all',"
            "{cache:'no-store'});return await r.json();}"
            "catch(e){return {fetch_error:String(e)};}})()"
        )
        if not isinstance(raw, dict) or "tls" not in raw:
            res["ok"] = False
            res["error"] = "no tls payload"
            res["raw"] = raw
            await _shot(core, "network_gate")
            return res
        tls = raw.get("tls", {})
        h2 = raw.get("http2", {})
        ja4 = tls.get("ja4", "")
        akamai = h2.get("akamai_fingerprint", "")
        ua = raw.get("user_agent", "")
        res.update({
            "exit_ip": raw.get("ip", ""),
            "http_version": raw.get("http_version", ""),
            "user_agent": ua,
            "tls_version_negotiated": tls.get("tls_version_negotiated", ""),
            "ja3_hash": tls.get("ja3_hash", ""),
            "ja4": ja4,
            "peetprint_hash": tls.get("peetprint_hash", ""),
            "akamai_fingerprint": akamai,
            "akamai_fingerprint_hash": h2.get("akamai_fingerprint_hash", ""),
        })
        # Structural Chrome-authenticity assertions (version-robust):
        checks = {
            # JA4 over TLS 1.3 advertising HTTP/2 ALPN: Chrome -> "t13d..h2.."
            "ja4_tls13_h2": ja4.startswith("t13d") and "h2" in ja4,
            # negotiated TLS 1.3
            "tls13": "1.3" in str(tls.get("tls_version_negotiated", "")),
            # HTTP/2 in use (Chrome ALPN-negotiates h2 to these endpoints)
            "http2": raw.get("http_version", "") in ("h2", "HTTP/2.0", "2"),
            # UA reports Chrome (the persona's UA, proxied untouched)
            "ua_is_chrome": "Chrome/" in ua and "Headless" not in ua,
            # Akamai H2 fingerprint matches known Chrome (report-only on drift)
            "akamai_matches_chrome": akamai == CHROME_AKAMAI_H2,
        }
        res["checks"] = checks
        # Gate = the structural checks; akamai exact-match is informational.
        gate = all(v for k, v in checks.items() if k != "akamai_matches_chrome")
        res["ok"] = gate
        await _shot(core, "network_gate")
    except Exception as e:  # noqa: BLE001
        res["ok"] = False
        res["error"] = str(e)[:200]
    finally:
        await core.close()
    print(f"  ok={res.get('ok')} ja4={res.get('ja4')} "
          f"akamai_match={res.get('checks', {}).get('akamai_matches_chrome')}")
    return res


async def enterprise_targets() -> dict:
    """Load real anti-bot-fronted pages through the proxy + behave humanly."""
    print("=== [2/3] enterprise live targets (via proxy) ===")
    results = []
    for name, url in _targets():
        core = NodriverCore(headless=False, use_proxy=True)
        entry: dict = {"name": name, "url": url}
        try:
            await core.open()
            nav = await core.navigate(url)
            await core.idle_activity(seconds=10.0)  # behavioral signal
            await asyncio.sleep(2)
            text = (await core.extract_text() or "")
            low = text.lower()
            hits = [m for m in BLOCK_MARKERS if m in low]
            entry.update({
                "final_url": nav.get("finalUrl", ""),
                "title": nav.get("title", ""),
                "text_len": len(text),
                "block_markers": hits,
                # A real page renders substantial text and trips no markers.
                "verdict": ("blocked/challenged" if hits
                            else ("ok" if len(text) > 400 else "thin")),
            })
            await _shot(core, f"enterprise_{name}")
        except Exception as e:  # noqa: BLE001
            entry["verdict"] = "error"
            entry["error"] = str(e)[:160]
        finally:
            await core.close()
        print(f"  {name:<12} verdict={entry.get('verdict')} "
              f"markers={entry.get('block_markers')}")
        results.append(entry)
    return {"check": "enterprise_targets", "results": results}


_WRITE_JS = """
(async () => {
  localStorage.setItem('apex_iso', 'PERSONA_A_SECRET');
  document.cookie = 'apex_iso=PERSONA_A_SECRET; path=/; max-age=86400';
  await new Promise((resolve) => {
    const req = indexedDB.open('apex_iso_db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('s');
    req.onsuccess = () => {
      const tx = req.result.transaction('s', 'readwrite');
      tx.objectStore('s').put('PERSONA_A_SECRET', 'k');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
  return {
    ls: localStorage.getItem('apex_iso'),
    cookie: document.cookie.includes('apex_iso'),
  };
})()
"""

_READ_JS = """
(async () => {
  const idb = await new Promise((resolve) => {
    const req = indexedDB.open('apex_iso_db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('s');
    req.onsuccess = () => {
      let store;
      try { store = req.result.transaction('s', 'readonly').objectStore('s'); }
      catch (e) { resolve(null); return; }
      const g = store.get('k');
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
  return {
    ls: localStorage.getItem('apex_iso'),
    cookie: (document.cookie.match(/apex_iso=([^;]*)/) || [null, null])[1],
    idb: idb,
  };
})()
"""

ISO_ORIGIN = "https://example.com/"


async def _persona_session(persona: str, js: str) -> dict:
    os.environ["APEX_PERSONA"] = persona
    core = NodriverCore(headless=False, use_proxy=True)
    try:
        await core.open()
        await core.navigate(ISO_ORIGIN)
        await asyncio.sleep(1.5)
        out = await core.eval_js(js)
        return out if isinstance(out, dict) else {"raw": out}
    finally:
        await core.close()


async def storage_isolation() -> dict:
    """Write storage as persona A, read as persona B (and re-read A)."""
    print("=== [3/3] cross-profile storage isolation ===")
    res: dict = {"check": "storage_isolation", "origin": ISO_ORIGIN}
    try:
        res["write_A"] = await _persona_session("iso-account-A", _WRITE_JS)
        res["read_B"] = await _persona_session("iso-account-B", _READ_JS)
        res["reread_A"] = await _persona_session("iso-account-A", _READ_JS)
        b = res["read_B"]
        a = res["reread_A"]
        b_clean = (b.get("ls") in (None, "null")
                   and not b.get("cookie") and b.get("idb") in (None, "null"))
        a_persists = (a.get("ls") == "PERSONA_A_SECRET"
                      and a.get("cookie") == "PERSONA_A_SECRET")
        res["isolated"] = bool(b_clean)
        res["a_persists"] = bool(a_persists)
        res["ok"] = bool(b_clean and a_persists)
    except Exception as e:  # noqa: BLE001
        res["ok"] = False
        res["error"] = str(e)[:200]
    finally:
        os.environ.pop("APEX_PERSONA", None)
    print(f"  isolated(B empty)={res.get('isolated')} "
          f"A_persists={res.get('a_persists')} ok={res.get('ok')}")
    return res


async def main() -> None:
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    report: dict = {}
    if which in ("all", "network"):
        report["network_gate"] = await network_gate()
    if which in ("all", "enterprise"):
        report["enterprise"] = await enterprise_targets()
    if which in ("all", "storage"):
        report["storage_isolation"] = await storage_isolation()
    (OUT / "acceptance.json").write_text(json.dumps(report, indent=2))
    print("=== acceptance summary ===")
    print(json.dumps({
        "network_ok": report.get("network_gate", {}).get("ok"),
        "enterprise": [
            {r["name"]: r.get("verdict")}
            for r in report.get("enterprise", {}).get("results", [])
        ],
        "storage_ok": report.get("storage_isolation", {}).get("ok"),
    }, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
