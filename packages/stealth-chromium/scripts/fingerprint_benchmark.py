#!/usr/bin/env python3
"""Real-fingerprinter benchmark for the patched binary.

This is the test the 22-surface self-check ISN'T: it puts the patched binary
(headful, on Xvfb -- the real stealth config, NOT --headless) in front of the
actual hard fingerprinters and captures their verdicts, so we have a real
market-comparison number instead of inferring from our own probes.

Targets:
  * CreepJS        -- trust score + lies/headless/stealth detectors (the hard one)
  * browserleaks   -- canvas / webgl / webrtc per-surface signatures + IP leak

Run headful under Xvfb with the patched binary:
  APEX_CHROME_PATH=/opt/stealth-chromium149/chrome APEX_CORE=nodriver \
    xvfb-run -a uv run --project ../stealth-browser \
      python scripts/fingerprint_benchmark.py

Saves the full rendered text of each page under /tmp/fpbench/ for inspection,
and prints the extracted headline signals.
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


async def _text(core, settle: float) -> str:
    await asyncio.sleep(settle)
    txt = await core.eval_js("document.body ? document.body.innerText : ''")
    return txt if isinstance(txt, str) else ""


def _grab(pattern: str, text: str, default="?") -> str:
    m = re.search(pattern, text, re.I)
    return m.group(1).strip() if m else default


async def creepjs(core) -> None:
    print("\n=== CreepJS (the hard one) ===")
    await core.navigate("https://abrahamjuliot.github.io/creepjs/")
    # CreepJS computes asynchronously; give it time to finish all workers.
    txt = await _text(core, 18.0)
    (OUT / "creepjs.txt").write_text(txt)
    try:
        png = await core.screenshot()
        (OUT / "creepjs.png").write_bytes(png)
    except Exception:
        pass
    # Headline signals (best-effort regexes against the rendered report).
    trust = _grab(r"trust score[^\d]*([\d.]+\s*%)", txt)
    lies = _grab(r"(\d+)\s*lie", txt)
    bot = _grab(r"\bbot\b[^\n]*?([0-9.]+%|true|false|none)", txt)
    fp = _grab(r"\b([0-9a-f]{8,})\b.*fingerprint|fingerprint[^\n]*?([0-9a-f]{8,})", txt)
    print(f"  trust score : {trust}")
    print(f"  lies        : {lies}")
    print(f"  bot/headless: {bot}")
    print(f"  fp id       : {fp}")
    # surface the lines mentioning headless/lies/stealth for a quick read
    for kw in ("headless", "stealth", "lies", "prototype", "tampering"):
        for line in txt.splitlines():
            if kw in line.lower() and len(line) < 160:
                print(f"   [{kw}] {line.strip()[:140]}")
                break
    print(f"  (full report saved to {OUT/'creepjs.txt'})")


async def browserleaks(core, name: str, url: str, settle=8.0) -> None:
    print(f"\n=== browserleaks/{name} ===")
    await core.navigate(url)
    txt = await _text(core, settle)
    (OUT / f"bl_{name}.txt").write_text(txt)
    # capture the most relevant lines
    keys = {
        "canvas": ("Signature", "Uniqueness", "PerimeterX", "data:image"),
        "webgl": ("Unmasked Vendor", "Unmasked Renderer", "Hash", "WebGL Report"),
        "webrtc": ("Local IP", "Public IP", "IPv4", "IPv6", "Leak"),
    }.get(name, ())
    for line in txt.splitlines():
        for k in keys:
            if k.lower() in line.lower() and len(line) < 160:
                print(f"   {line.strip()[:150]}")
                break
    print(f"  (saved to {OUT/('bl_'+name+'.txt')})")


async def main() -> int:
    bin_path = os.environ.get("APEX_CHROME_PATH")
    print(f"=== fingerprint benchmark ===")
    print(f"  binary : {bin_path or '(stock Chrome)'}")
    print(f"  core   : {os.environ.get('APEX_CORE', 'nodriver')} (HEADFUL on Xvfb)")
    core = NodriverCore(headless=False)
    print(f"  profile: {core.profile.get('fingerprint', {})}")
    await core.open()
    try:
        await creepjs(core)
        await browserleaks(core, "canvas", "https://browserleaks.com/canvas")
        await browserleaks(core, "webgl", "https://browserleaks.com/webgl")
        await browserleaks(core, "webrtc", "https://browserleaks.com/webrtc")
    finally:
        await core.close()
    print(f"\n=== done -- inspect raw reports in {OUT} ===")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
