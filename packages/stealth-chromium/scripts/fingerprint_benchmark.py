#!/usr/bin/env python3
"""Real-fingerprinter benchmark for the patched binary -- the FULL panel.

The 22-surface self-check proves our patches fire; this proves they survive the
hardest fingerprinters and bot-detectors on the open web. Runs the patched
binary HEADFUL on Xvfb (the real stealth config, NOT --headless) through a
panel of composite coherence scanners, per-surface probes, headless/automation
detectors, uniqueness trackers, and a Cloudflare challenge -- capturing each
one's verdict so we have a real, multi-source market comparison.

Run:
  APEX_CHROME_PATH=/opt/stealth-chromium149/chrome APEX_CORE=nodriver \
    xvfb-run -a uv run --project ../stealth-browser \
      python scripts/fingerprint_benchmark.py [name ...]

Pass target names to run a subset (e.g. `creepjs iphey pixelscan`). Full
rendered text + a screenshot of every target are saved under /tmp/fpbench/.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent
                       / "stealth-browser"))

from stealth_browser.core_nodriver import NodriverCore  # noqa: E402

OUT = Path("/tmp/fpbench")
OUT.mkdir(parents=True, exist_ok=True)

# Each target: name, url, settle seconds (JS-heavy scanners need time),
# `scores` = headline verdicts to regex out, `lines` = keywords whose matching
# lines we echo for a quick read. Grouped by what they test.
TARGETS = [
    # --- composite coherence scanners (the hard ones) ---
    {"name": "incolumitas",
     "url": "https://bot.incolumitas.com/", "settle": 26, "tier": "composite",
     "scores": {"fp": r'"fpBotScore"\s*:\s*([\d.]+)|"bot"\s*:\s*(false|true|[\d.]+)',
                "behav": r'"behavioralClassificationScore"\s*:\s*([\d.]+)'},
     "lines": ["bot", "fpBotScore", "behavioralClass", "webdriver",
               "datacenter", "fp.", "score", "isBot", "tagger"]},
    {"name": "creepjs", "url": "https://abrahamjuliot.github.io/creepjs/",
     "settle": 20, "tier": "composite",
     "scores": {"trust": r"trust score[^\d]*([\d.]+\s*%)",
                "lies": r"(\d+)\s*lie", "bot": r"\bbot\b[^\n]{0,30}",
                "resists": r"(\d+\s*%)\s*(?:unique|resist)"},
     "lines": ["headless", "stealth", "lies", "prototype", "tampering",
               "like headless", "trust score"]},
    {"name": "iphey", "url": "https://iphey.com/", "settle": 14,
     "tier": "composite",
     "scores": {"verdict": r"(Trustworthy|Suspicious|Not reliable)"},
     "lines": ["Trustworthy", "Suspicious", "Software", "Hardware",
               "Network", "Location", "webdriver", "proxy"]},
    {"name": "pixelscan", "url": "https://pixelscan.net/", "settle": 18,
     "tier": "composite",
     "scores": {"bot": r"(do not look like a bot|you look like a bot|"
                       r"automation (?:framework )?detected)",
                "consistency": r"(consistent|inconsistent)"},
     "lines": ["bot", "automation", "consistent", "masking", "vpn",
               "proxy", "fingerprint"]},
    {"name": "browserscan", "url": "https://www.browserscan.net/", "settle": 18,
     "tier": "composite",
     "scores": {"bot": r"Robot[^\n]{0,30}|Bot[^\n]{0,30}",
                "score": r"(\d+\s*%)"},
     "lines": ["Robot", "Bot", "WebDriver", "CDP", "Automation",
               "Hardware", "Software"]},
    {"name": "deviceinfo", "url": "https://deviceandbrowserinfo.com/are_you_a_bot",
     "settle": 12, "tier": "composite",
     "scores": {"bot": r"(you are (?:probably )?(?:not )?a bot|"
                       r"bot detected|not a bot)"},
     "lines": ["bot", "headless", "webdriver", "automation"]},
    # --- headless / automation detectors ---
    {"name": "sannysoft", "url": "https://bot.sannysoft.com/", "settle": 9,
     "tier": "headless",
     "scores": {"webdriver": r"webdriver[^\n]{0,40}"},
     "lines": ["webdriver", "missing", "present", "failed", "passed",
               "HeadlessChrome", "Chrome (New)", "Plugins", "Permissions"]},
    {"name": "areyouheadless",
     "url": "https://arh.antoinevastel.com/bots/areyouheadless", "settle": 8,
     "tier": "headless",
     "scores": {"verdict": r"(not Chrome headless|Chrome headless)"},
     "lines": ["headless", "Chrome"]},
    {"name": "fingerprintjs", "url": "https://demo.fingerprint.com/", "settle": 16,
     "tier": "headless",
     "scores": {"bot": r"(bot detected|no bot detected|automation tool)",
                "visitorId": r"\b([0-9a-zA-Z]{18,22})\b"},
     "lines": ["bot", "incognito", "visitorId", "confidence", "VPN"]},
    # --- per-surface (browserleaks) ---
    {"name": "bl_canvas", "url": "https://browserleaks.com/canvas", "settle": 9,
     "tier": "surface",
     "scores": {"signature": r"Signature[^\n]*?([0-9A-F]{6,})",
                "uniqueness": r"Uniqueness[^\n]*?([\d.]+\s*%)"},
     "lines": ["Signature", "Uniqueness", "Hash", "Unique"]},
    {"name": "bl_webgl", "url": "https://browserleaks.com/webgl", "settle": 9,
     "tier": "surface",
     "scores": {"vendor": r"Unmasked Vendor[^\n]*?:\s*(.+)",
                "renderer": r"Unmasked Renderer[^\n]*?:\s*(.+)"},
     "lines": ["Unmasked Vendor", "Unmasked Renderer", "Hash", "WebGL"]},
    {"name": "bl_webrtc", "url": "https://browserleaks.com/webrtc", "settle": 9,
     "tier": "surface",
     "scores": {"leak": r"(\d+\.\d+\.\d+\.\d+)"},
     "lines": ["Local IP", "Public IP", "IPv4", "IPv6", "Leak", "candidate"]},
    {"name": "bl_fonts", "url": "https://browserleaks.com/fonts", "settle": 9,
     "tier": "surface",
     "scores": {"count": r"(\d+)\s*fonts?", "hash": r"Hash[^\n]*?([0-9a-f]{6,})"},
     "lines": ["fonts detected", "Fingerprint", "Hash"]},
    {"name": "bl_tls", "url": "https://browserleaks.com/tls", "settle": 9,
     "tier": "surface",
     "scores": {"ja3": r"JA3[^\n]*?([0-9a-f]{32})",
                "ja4": r"JA4[^\n]*?([a-z0-9_]{20,})"},
     "lines": ["JA3", "JA4", "User Agent", "Cipher"]},
    {"name": "bl_js", "url": "https://browserleaks.com/javascript", "settle": 8,
     "tier": "surface",
     "scores": {},
     "lines": ["User Agent", "Platform", "Hardware", "Memory",
               "Languages", "Sec-CH-UA"]},
    # --- uniqueness / anti-bot challenge ---
    {"name": "amiunique", "url": "https://amiunique.org/fingerprint", "settle": 14,
     "tier": "uniqueness",
     "scores": {"unique": r"(you are unique|not unique|[\d.]+\s*%)"},
     "lines": ["unique", "fingerprint", "among"]},
    {"name": "cloudflare", "url": "https://nowsecure.nl/", "settle": 12,
     "tier": "challenge",
     "scores": {"passed": r"(OH YEAH|you (?:are|'re) (?:a )?human|verify|"
                          r"checking your browser|Just a moment)"},
     "lines": ["human", "checking", "moment", "verify", "blocked", "Ray ID"]},
]


def _grab(pattern: str, text: str, default="-") -> str:
    m = re.search(pattern, text, re.I)
    if not m:
        return default
    return (m.group(1) if m.lastindex else m.group(0)).strip()[:80]


async def run_target(core, t: dict) -> dict:
    name, url = t["name"], t["url"]
    print(f"\n=== [{t['tier']}] {name}  ({url}) ===")
    result = {"name": name, "tier": t["tier"]}
    try:
        await core.navigate(url)
    except Exception as e:  # noqa: BLE001 - capture whatever rendered anyway
        print(f"   navigate warn: {str(e)[:80]}")
    await asyncio.sleep(t["settle"])
    try:
        txt = await core.eval_js("document.body ? document.body.innerText : ''")
        txt = txt if isinstance(txt, str) else ""
    except Exception as e:  # noqa: BLE001
        print(f"   eval failed: {str(e)[:80]}")
        txt = ""
    (OUT / f"{name}.txt").write_text(txt)
    try:
        (OUT / f"{name}.png").write_bytes(await core.screenshot())
    except Exception:  # noqa: BLE001
        pass
    for label, pat in t.get("scores", {}).items():
        val = _grab(pat, txt)
        result[label] = val
        print(f"   {label:12s}: {val}")
    seen = set()
    for kw in t.get("lines", []):
        for line in txt.splitlines():
            ls = line.strip()
            if kw.lower() in ls.lower() and ls and ls not in seen and len(ls) < 160:
                print(f"     · {ls[:140]}")
                seen.add(ls)
                break
    if not txt:
        print("   (no body text captured -- see screenshot)")
    return result


async def main() -> int:
    want = set(sys.argv[1:])
    targets = [t for t in TARGETS if not want or t["name"] in want]
    print("=== fingerprint benchmark (full panel) ===")
    print(f"  binary : {os.environ.get('APEX_CHROME_PATH') or '(stock Chrome)'}")
    print(f"  core   : {os.environ.get('APEX_CORE', 'nodriver')} (HEADFUL/Xvfb)")
    print(f"  targets: {', '.join(t['name'] for t in targets)}")
    core = NodriverCore(headless=False)
    print(f"  profile: {core.profile.get('fingerprint', {})}")
    await core.open()
    results = []
    try:
        for t in targets:
            try:
                results.append(await run_target(core, t))
            except Exception as e:  # noqa: BLE001 - one site shouldn't kill the run
                print(f"   !! {t['name']} errored: {str(e)[:100]}")
    finally:
        await core.close()

    print("\n=== SUMMARY (headline verdicts) ===")
    for r in results:
        head = "  ".join(f"{k}={v}" for k, v in r.items()
                          if k not in ("name", "tier"))
        print(f"  [{r['tier']:10s}] {r['name']:14s} {head}")
    print(f"\nRaw reports + screenshots: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
