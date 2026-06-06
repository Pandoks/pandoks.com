#!/usr/bin/env python3
"""Reproduce the production WebGL death IN-SESSION via the real NodriverCore.

The launch-flag bisect (webgl_ab.py) proved WebGL is alive at launch in every
flag/kwarg combination -- yet the full panel shows WebGL 'disabled or
unavailable' by its 2nd site (creepjs). So WebGL dies DURING the session. This
drives the real NodriverCore through the panel's opening sequence and probes
WebGL after each navigation to localise exactly where it dies.

    APEX_CHROME_PATH=/path/to/chrome python webgl_session.py
"""
from __future__ import annotations

import asyncio

from stealth_browser.core_nodriver import NodriverCore

PROBE = r"""(() => {
  const c = document.createElement('canvas');
  let gl = null;
  try { gl = c.getContext('webgl') || c.getContext('experimental-webgl'); }
  catch (e) { return {ok:false, err:String(e)}; }
  if (!gl) return {ok:false, err:'no context'};
  const u = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : null,
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
})()"""


async def probe(core: NodriverCore, when: str) -> None:
    try:
        r = await core.eval_js(PROBE)
        r = r if isinstance(r, dict) else {"raw": r}
    except Exception as e:  # noqa: BLE001
        r = {"ok": "ERR", "err": str(e)}
    tag = "OK  " if r.get("ok") is True else "DEAD"
    print(f"WEBGL-{tag} after {when:28} "
          f"renderer={(r.get('renderer') or '')[:40]!r} maxTex={r.get('maxTex')} "
          f"err={r.get('err')!r}")


async def main() -> int:
    core = NodriverCore(headless=False)
    await core.open()
    try:
        await core.navigate("https://example.com/")
        await probe(core, "example.com (site 1)")

        await core.navigate("https://bot.incolumitas.com/")
        await asyncio.sleep(3)
        await probe(core, "incolumitas nav (pre-activity)")
        await core.idle_activity(15)
        await probe(core, "incolumitas + idle_activity(15)")

        await core.navigate("https://abrahamjuliot.github.io/creepjs/")
        await asyncio.sleep(5)
        await probe(core, "creepjs (site 3)")
    finally:
        await core.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
