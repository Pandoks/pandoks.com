#!/usr/bin/env python3
"""Investigate behavioral bot detection against incolumitas.

The panel showed incolumitas's `Behavioral Score: ...` never populated despite
running the ghost cursor. This probe finds out WHY: it installs an in-page
mouse/pointer-event counter, runs the ghost-cursor idle_activity, then reports
(a) how many mousemove/pointermove events actually fired and whether they're
isTrusted, and (b) the behavioral score the page computed. If events fire with
isTrusted=true but the score stays unset, the issue is incolumitas's model;
if no events fire, CDP Input.dispatchMouseEvent isn't reaching the page (the
real gap a DataDome-class behavioral layer would exploit).

    APEX_CHROME_PATH=/path/to/chrome python behavior_probe.py
"""
from __future__ import annotations

import asyncio

from stealth_browser.core_nodriver import NodriverCore

COUNTER_JS = r"""
(() => {
  window.__apexMM = 0; window.__apexPM = 0;
  window.__apexTrusted = null; window.__apexLast = null;
  document.addEventListener('mousemove', (e) => {
    window.__apexMM++; window.__apexTrusted = e.isTrusted;
    window.__apexLast = [Math.round(e.clientX), Math.round(e.clientY)];
  }, true);
  document.addEventListener('pointermove', () => { window.__apexPM++; }, true);
  return 'counter installed';
})()
"""

READ_JS = r"""
(() => {
  const t = document.body ? document.body.innerText : '';
  const m = t.match(/Behavioral Score:\s*([\d.]+|\.\.\.)/);
  return {
    mousemove: window.__apexMM, pointermove: window.__apexPM,
    isTrusted: window.__apexTrusted, lastXY: window.__apexLast,
    behavioralScore: m ? m[1] : 'not-found',
  };
})()
"""


async def main() -> int:
    core = NodriverCore(headless=False)
    await core.open()
    try:
        await core.navigate("https://bot.incolumitas.com/")
        await asyncio.sleep(6)
        print("install counter:", await core.eval_js(COUNTER_JS))
        # drive the ghost cursor for the behavioral window (updates at
        # 1.5/4/7/10/15s of activity)
        await core.idle_activity(18)
        await asyncio.sleep(2)
        res = await core.eval_js(READ_JS)
        print("BEHAVIOR_RESULT:", res)
    finally:
        await core.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
