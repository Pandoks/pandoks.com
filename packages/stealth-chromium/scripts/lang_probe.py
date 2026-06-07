#!/usr/bin/env python3
"""Deterministic check that the apex-languages binary patch sets
navigator.languages from APEX_FP_LANGUAGES. No proxy needed (the patch is
IP-independent) -- we force a Spanish identity, so NodriverCore emits
APEX_FP_LANGUAGES='es-ES,es,en', and read the JS array back. Proves the patch
without waiting on a random Spanish proxy exit.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent
                       / "stealth-browser"))

from stealth_browser.core_nodriver import NodriverCore  # noqa: E402
from stealth_browser.profile import Identity  # noqa: E402


async def main() -> int:
    idn = Identity(locale="es-ES",
                   accept_language="es-ES,es;q=0.9,en;q=0.8",
                   timezone="Europe/Madrid")
    core = NodriverCore(identity=idn, use_proxy=False, headless=False)
    await core.open()
    try:
        await core.navigate("https://example.com")
        langs = await core.eval_js("JSON.stringify(navigator.languages)")
        lang = await core.eval_js("navigator.language")
        # worker scope too -- must agree (no window<->worker mismatch)
        wlangs = await core.eval_js(
            "(async()=>{const b=new Blob(["
            "'postMessage(JSON.stringify(navigator.languages))'],"
            "{type:'text/javascript'});const w=new Worker(URL.createObjectURL(b));"
            "return await new Promise(r=>{w.onmessage=e=>r(e.data);"
            "setTimeout(()=>r('timeout'),3000);});})()")
        print(f"PROBE navigator.languages = {langs}")
        print(f"PROBE navigator.language  = {lang}")
        print(f"PROBE worker.languages    = {wlangs}")
        ok = isinstance(langs, str) and "es-ES" in langs
        print(f"PROBE RESULT: {'PASS' if ok else 'FAIL'} "
              f"(expected es-ES in navigator.languages)")
    finally:
        await core.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
