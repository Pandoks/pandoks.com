#!/usr/bin/env python3
"""Reproduce + fix the in-session WebGL death using the REAL NodriverCore.

The plain NodriverCore sequence (example->incolumitas->creepjs) did NOT kill
WebGL. The panel differs in two ways this replicates: incolumitas is the FIRST
site (cold GPU's first job is the heavy 18s fingerprinter) and it calls
screenshot() after every site (a software-composited capture on llvmpipe).
Either can crash the GPU process, after which WebGL is disabled for all later
sites. Driven by env so the wrapper can A/B:

    APEX_SHOT=1            take a screenshot after each site (panel-faithful)
    APEX_EXTRA_FLAGS=...   extra Chrome flags (e.g. --disable-gpu-watchdog)
    APEX_CHROME_PATH=...   the patched binary

    python webgl_fix.py <label>
"""
from __future__ import annotations

import asyncio
import os
import sys

from stealth_browser.core_nodriver import NodriverCore

PROBE = r"""(() => {
  const c = document.createElement('canvas');
  let gl=null; try { gl=c.getContext('webgl')||c.getContext('experimental-webgl'); }
  catch(e){ return {ok:false}; }
  if(!gl) return {ok:false};
  const u=gl.getExtension('WEBGL_debug_renderer_info');
  return {ok:true, renderer:u?gl.getParameter(u.UNMASKED_RENDERER_WEBGL):null,
          maxTex:gl.getParameter(gl.MAX_TEXTURE_SIZE)};
})()"""

# Panel-faithful opening sequence: incolumitas FIRST.
SITES = [
    ("incolumitas(1)", "https://bot.incolumitas.com/", 16, True),
    ("creepjs(2)", "https://abrahamjuliot.github.io/creepjs/", 6, False),
    ("browserleaks(3)", "https://browserleaks.com/webgl", 6, False),
]


async def probe(core, when, results) -> None:
    try:
        r = await core.eval_js(PROBE)
        r = r if isinstance(r, dict) else {"ok": "?"}
    except Exception as e:  # noqa: BLE001
        r = {"ok": "ERR", "e": str(e)[:40]}
    ok = r.get("ok") is True
    results.append(ok)
    print(f"    WEBGL-{'OK  ' if ok else 'DEAD'} after {when:18} "
          f"renderer={(r.get('renderer') or '')[:34]!r} maxTex={r.get('maxTex')}")


async def main() -> int:
    label = sys.argv[1] if len(sys.argv) > 1 else "run"
    shot = os.environ.get("APEX_SHOT") == "1"
    core = NodriverCore(headless=False)
    await core.open()
    results: list = []
    try:
        for name, url, wait, behave in SITES:
            try:
                await core.navigate(url)
                await asyncio.sleep(2)
                if behave:
                    try:
                        await core.idle_activity(wait)
                    except Exception as e:  # noqa: BLE001
                        print(f"    idle warn {name}: {str(e)[:50]}")
                else:
                    await asyncio.sleep(wait)
                if shot:
                    try:
                        await core.screenshot()
                    except Exception as e:  # noqa: BLE001
                        print(f"    shot warn {name}: {str(e)[:50]}")
                await probe(core, name, results)
            except Exception as e:  # noqa: BLE001
                print(f"    NAV-FAIL {name}: {str(e)[:60]}")
                results.append(False)
    finally:
        await core.close()
    survived = all(results) and len(results) == len(SITES)
    print(f"FIX [{label}] shot={shot} extra={os.environ.get('APEX_EXTRA_FLAGS','')!r} "
          f"-> {'SURVIVED' if survived else 'FAILED'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
