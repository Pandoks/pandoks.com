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
    # Commercial bot detectors that return a SCORE and transit the residential
    # exit (verified): these give real verdicts.
    ("browserscan", "https://www.browserscan.net/bot-detection"),
    ("fingerprintjs", "https://demo.fingerprint.com/"),
    ("deviceinfo", "https://deviceandbrowserinfo.com/are_you_a_bot"),
    ("incolumitas", "https://bot.incolumitas.com/"),
    # Cloudflare / DataDome live edges -- may be "unreachable" through this exit
    # (transport), honestly labeled when so.
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


async def _peet_fingerprint(use_proxy: bool) -> dict:
    """One attempt: launch a core (proxy or direct), fetch tls.peet.ws/api/all.

    Returns {"reached": bool, ...fields}. JA3/JA4/Akamai-H2 are properties of
    Chrome's OWN handshake and are IP-independent -- and the ProxyForwarder is a
    transparent CONNECT byte-pipe (it cannot alter TLS) -- so a direct run
    measures the exact same fingerprint that exits the proxy.
    """
    core = NodriverCore(headless=False, use_proxy=use_proxy)
    out: dict = {"path": "proxy" if use_proxy else "direct", "reached": False}
    try:
        await core.open()
        prof = core.profile
        out["proxy_active"] = prof["proxy"]["active"]
        out["exit_geo"] = prof["proxy"]["exit_geo"]
        out["persona_ua_platform"] = prof["fingerprint"]["device_profile"]
        nav = await core.navigate("https://tls.peet.ws/")
        await asyncio.sleep(1)
        if "chrome-error" in nav.get("finalUrl", ""):
            out["error"] = "navigation failed (transport)"
            await _shot(core, f"network_gate_{out['path']}")
            return out
        raw = await core.eval_js(
            "(async()=>{try{const r=await fetch('/api/all',"
            "{cache:'no-store'});return await r.json();}"
            "catch(e){return {fetch_error:String(e)};}})()"
        )
        if not isinstance(raw, dict) or "tls" not in raw:
            out["error"] = "no tls payload"
            out["raw"] = raw
            await _shot(core, f"network_gate_{out['path']}")
            return out
        tls = raw.get("tls", {})
        h2 = raw.get("http2", {})
        ja4 = tls.get("ja4", "")
        akamai = h2.get("akamai_fingerprint", "")
        ua = raw.get("user_agent", "")
        out.update({
            "reached": True,
            "exit_ip": raw.get("ip", ""),
            "http_version": raw.get("http_version", ""),
            "user_agent": ua,
            "tls_version_negotiated": tls.get("tls_version_negotiated", ""),
            "ja3_hash": tls.get("ja3_hash", ""),
            "ja4": ja4,
            "peetprint_hash": tls.get("peetprint_hash", ""),
            "akamai_fingerprint": akamai,
            "akamai_fingerprint_hash": h2.get("akamai_fingerprint_hash", ""),
            "checks": {
                "ja4_tls13_h2": ja4.startswith("t13d") and "h2" in ja4,
                "tls13": "1.3" in str(tls.get("tls_version_negotiated", "")),
                "http2": raw.get("http_version", "") in ("h2", "HTTP/2.0", "2"),
                "ua_is_chrome": "Chrome/" in ua and "Headless" not in ua,
                "akamai_matches_chrome": akamai == CHROME_AKAMAI_H2,
            },
        })
        await _shot(core, f"network_gate_{out['path']}")
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)[:200]
    finally:
        await core.close()
    return out


async def network_gate() -> dict:
    """Confirm the exiting TLS/HTTP2 fingerprint is authentic Chrome.

    Try through the proxy first; if the residential exit can't reach tls.peet.ws
    (a transport limitation -- some exits drop CDN-fronted domains), fall back to
    a direct run. The fingerprint is identical either way (transparent tunnel),
    so the direct measurement still answers "is our TLS authentic Chrome?".
    """
    print("=== [1/3] network acceptance gate (tls.peet.ws) ===")
    res: dict = {"check": "network_gate"}
    attempt = await _peet_fingerprint(use_proxy=True)
    res["attempts"] = [attempt]
    if not attempt.get("reached"):
        print("  proxy path unreachable -- retrying direct (IP-independent)")
        direct = await _peet_fingerprint(use_proxy=False)
        res["attempts"].append(direct)
        attempt = direct if direct.get("reached") else attempt
    res.update({k: v for k, v in attempt.items() if k != "path"})
    res["measured_via"] = attempt.get("path")
    checks = attempt.get("checks", {})
    res["ok"] = bool(attempt.get("reached") and all(
        v for k, v in checks.items() if k != "akamai_matches_chrome"))
    print(f"  via={res.get('measured_via')} reached={attempt.get('reached')} "
          f"ok={res.get('ok')} ja4={res.get('ja4')} "
          f"akamai_match={checks.get('akamai_matches_chrome')}")
    return res


async def enterprise_targets() -> dict:
    """Load real anti-bot-fronted pages + behave humanly, on ONE shared core.

    One long-lived browser navigating sequentially is the panel-proven pattern
    (a fresh browser+forwarder per target was less reliable). A chrome-error
    landing means the page never loaded (residential exit dropped the
    connection) -- reported as "unreachable", NOT "blocked": no detection
    occurred, so it must not be read as a fingerprint failure.
    """
    print("=== [2/3] enterprise live targets (via proxy, shared core) ===")
    results = []
    core = NodriverCore(headless=False, use_proxy=True)
    try:
        await core.open()
        exit_geo = core.profile["proxy"]["exit_geo"]
        for name, url in _targets():
            entry: dict = {"name": name, "url": url}
            try:
                nav = await core.navigate(url)
                final = nav.get("finalUrl", "")
                if "chrome-error" in final:
                    entry.update({"final_url": final, "verdict": "unreachable",
                                  "note": "exit dropped connection (transport)"})
                else:
                    await core.idle_activity(seconds=10.0)  # behavioral signal
                    await asyncio.sleep(2)
                    text = (await core.extract_text() or "")
                    low = text.lower()
                    hits = [m for m in BLOCK_MARKERS if m in low]
                    entry.update({
                        "final_url": final,
                        "title": nav.get("title", ""),
                        "text_len": len(text),
                        "block_markers": hits,
                        "verdict": ("blocked/challenged" if hits
                                    else ("ok" if len(text) > 400 else "thin")),
                    })
                await _shot(core, f"enterprise_{name}")
            except Exception as e:  # noqa: BLE001
                entry["verdict"] = "error"
                entry["error"] = str(e)[:160]
            print(f"  {name:<12} verdict={entry.get('verdict')} "
                  f"markers={entry.get('block_markers', [])}")
            results.append(entry)
    finally:
        await core.close()
    return {"check": "enterprise_targets", "exit_geo": exit_geo,
            "results": results}


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
        # localStorage + IndexedDB are the reliable persistence signals; the
        # cookie store flushes to disk on a timer, so it may lag a fast
        # close -- record it but don't gate persistence on it.
        a_persists = (a.get("ls") == "PERSONA_A_SECRET"
                      and a.get("idb") == "PERSONA_A_SECRET")
        res["isolated"] = bool(b_clean)
        res["a_persists"] = bool(a_persists)
        res["a_cookie_persisted"] = a.get("cookie") == "PERSONA_A_SECRET"
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
