#!/usr/bin/env python3
"""Verify the PRODUCTION launch path produces a coherent Android phone.

android_probe proved the raw CDP mechanism; this proves the wired-in path:
NodriverCore picks the Android persona -> fp_env emits the GPU subset ->
StealthBrowser._apply_mobile applies the CDP device emulation. If this dumps a
coherent phone, mobile is production-ready (no rebuild).

    APEX_CHROME_PATH=/path/to/chrome python mobile_prod_probe.py [label]
"""
from __future__ import annotations

import asyncio
import json
import sys

from stealth_browser.core_nodriver import NodriverCore
from stealth_browser.fp_profiles import pick_profile_by_label

PROBE = r"""(async () => {
  let he = {};
  try { he = await navigator.userAgentData.getHighEntropyValues(
    ['platform','platformVersion','model','mobile','formFactors']); } catch(e){ he={err:String(e)}; }
  const gl = document.createElement('canvas').getContext('webgl');
  const u = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ua: navigator.userAgent, platform: navigator.platform,
    uadMobile: navigator.userAgentData ? navigator.userAgentData.mobile : 'no-uad',
    uadPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    he, maxTouchPoints: navigator.maxTouchPoints,
    ontouchstart: 'ontouchstart' in window, dpr: window.devicePixelRatio,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    sw: screen.width, sh: screen.height,
    cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    webglRenderer: u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : '',
  };
})()"""


async def main() -> int:
    label = sys.argv[1] if len(sys.argv) > 1 else "Galaxy S23"
    core = NodriverCore(headless=False)
    p = pick_profile_by_label(label)
    if p is None:
        print(f"NO_PROFILE for {label!r}")
        return 1
    core._fp_profile = p  # force the persona under test
    print(f"persona: {p.label} (is_mobile={p.is_mobile})")
    await core.open()
    try:
        await core.navigate("https://example.com/")
        await asyncio.sleep(1.5)
        r = await core.eval_js(PROBE)
        r = r if isinstance(r, dict) else {"raw": str(r)[:200]}
        print("MOBILE_PROD_RESULT " + json.dumps(r, sort_keys=True))
    finally:
        await core.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
