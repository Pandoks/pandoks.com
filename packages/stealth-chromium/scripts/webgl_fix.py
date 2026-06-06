#!/usr/bin/env python3
"""Test GPU-process-stability flag sets against the in-session WebGL death.

webgl_session.py reproduces WebGL dying mid-session (software renderer GPU
process killed under heavy WebGL fingerprinting, then GL permanently disabled).
This drives the same site sequence with candidate stability flags and probes
WebGL after each nav, so the wrapper can pick the set that keeps WebGL alive
through the whole session. Each mode = one browser/process (via the wrapper).

    APEX_CHROME_PATH=/path/to/chrome python webgl_fix.py <mode>
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import nodriver
from stealth_browser.profile import chrome_launch_flags, Identity
from stealth_browser.runner_nodriver import _unwrap

WATCHDOG = "--disable-gpu-watchdog"
CRASHLIM = "--disable-gpu-process-crash-limit"

PROBE = r"""(() => {
  const c = document.createElement('canvas');
  let gl=null; try { gl=c.getContext('webgl')||c.getContext('experimental-webgl'); }
  catch(e){ return {ok:false,err:String(e)}; }
  if(!gl) return {ok:false,err:'no context'};
  const u=gl.getExtension('WEBGL_debug_renderer_info');
  return {ok:true, renderer:u?gl.getParameter(u.UNMASKED_RENDERER_WEBGL):null,
          maxTex:gl.getParameter(gl.MAX_TEXTURE_SIZE)};
})()"""

SITES = [
    ("example (1)", "https://example.com/", 2),
    ("incolumitas+wait (2)", "https://bot.incolumitas.com/", 16),
    ("creepjs (3)", "https://abrahamjuliot.github.io/creepjs/", 6),
    ("browserleaks-webgl (4)", "https://browserleaks.com/webgl", 6),
]


def flags_for(mode: int):
    os.environ["STEALTH_IN_DOCKER"] = "1"
    base = chrome_launch_flags(Identity(), headless=False)
    if mode == 0:
        return base, "control (production flags)"
    if mode == 1:
        return base + [WATCHDOG], "+ disable-gpu-watchdog"
    if mode == 2:
        return base + [WATCHDOG, CRASHLIM], "+ watchdog + crash-limit"
    if mode == 3:
        swap = ["--use-angle=swiftshader" if f == "--use-angle=gl" else f
                for f in base]
        return swap + [WATCHDOG, CRASHLIM], "+ watchdog + crash-limit + SwiftShader"
    raise SystemExit(f"bad mode {mode}")


async def probe(tab, when, results):
    try:
        raw = await tab.evaluate(PROBE, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    except Exception as e:  # noqa: BLE001
        r = {"ok": "ERR", "err": str(e)}
    ok = r.get("ok") is True
    results.append(ok)
    print(f"    WEBGL-{'OK  ' if ok else 'DEAD'} after {when:24} "
          f"renderer={(r.get('renderer') or '')[:34]!r} maxTex={r.get('maxTex')}")


async def main() -> None:
    mode = int(sys.argv[1])
    args, label = flags_for(mode)
    page = Path(tempfile.gettempdir()) / "apex_fix.html"
    page.write_text("<!doctype html><html><body>x</body></html>")
    browser = await nodriver.start(
        browser_executable_path=os.environ["APEX_CHROME_PATH"],
        headless=False, sandbox=False, browser_args=args)
    results: list = []
    try:
        for name, url, wait in SITES:
            try:
                tab = await browser.get(url)
                await asyncio.sleep(wait)
                await probe(tab, name, results)
            except Exception as e:  # noqa: BLE001
                print(f"    NAV-FAIL {name}: {e}")
                results.append(False)
    finally:
        browser.stop()
    survived = all(results) and len(results) == len(SITES)
    print(f"FIX [{mode}] {'SURVIVED' if survived else 'FAILED  '} {label}")


if __name__ == "__main__":
    asyncio.run(main())
