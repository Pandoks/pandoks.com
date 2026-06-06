#!/usr/bin/env python3
"""Prove the Android-persona METHOD: emulate a mobile device entirely at runtime
via CDP (the same mechanism DevTools device-mode / Puppeteer use), no rebuild.

Mobile is NOT a new C++ patch -- it's CDP Emulation:
  * setUserAgentOverride(ua, platform, user_agent_metadata)  -> UA string +
    navigator.platform + navigator.userAgentData (mobile/platform/model). We
    REUSE our real Chrome-149 brands (read them first) so the brand list is
    never fabricated -- only the platform bits become Android.
  * setDeviceMetricsOverride(w,h,dpr,mobile=True) -> screen/DPR/viewport +
    (pointer:coarse)/(hover:none) media queries.
  * setTouchEmulationEnabled(True, maxTouchPoints) -> touch + maxTouchPoints.
Plus APEX_FP_* env for the GPU (Adreno) + cores/memory the binary spoofs.

Reduced Android UA is frozen to "Android 10; K"; the real model/version live
ONLY in UA-CH high-entropy (verified). This probe applies it all and dumps
every mobile surface so we can judge coherence + iterate.

    APEX_CHROME_PATH=/path/to/chrome python android_probe.py
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

import nodriver
from nodriver import cdp
from stealth_browser.runner_nodriver import _unwrap

# Galaxy S23 reference (CSS 360x780 @ DPR 3, Adreno 740, Snapdragon 8 Gen 2).
UA = ("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36")
PROBE = r"""(async () => {
  let he = {};
  try { he = await navigator.userAgentData.getHighEntropyValues(
    ['platform','platformVersion','model','architecture','bitness','mobile','fullVersionList','formFactors']); } catch(e){ he={err:String(e)}; }
  const gl = document.createElement('canvas').getContext('webgl');
  const u = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    uadMobile: navigator.userAgentData ? navigator.userAgentData.mobile : 'no-uad',
    uadPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    he,
    maxTouchPoints: navigator.maxTouchPoints,
    hasOntouchstart: 'ontouchstart' in window,
    hasTouchEvent: typeof TouchEvent !== 'undefined',
    dpr: window.devicePixelRatio,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    anyHover: matchMedia('(any-hover: none)').matches,
    sw: screen.width, sh: screen.height, iw: innerWidth, ih: innerHeight,
    cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    webglRenderer: u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : '',
    webglVendor: u ? gl.getParameter(u.UNMASKED_VENDOR_WEBGL) : '',
  };
})()"""


async def main() -> None:
    for k in list(os.environ):
        if k.startswith("APEX_FP_"):
            del os.environ[k]
    # GPU + cores/mem the binary spoofs natively; UA/platform/touch/DPR via CDP.
    os.environ.update({
        "APEX_FP_ACTIVE": "1", "APEX_FP_SEED": "4242",
        "APEX_FP_HW_CONCURRENCY": "8", "APEX_FP_DEVICE_MEMORY": "8",
        "APEX_FP_WEBGL_VENDOR": "Qualcomm",
        "APEX_FP_WEBGL_RENDERER": "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)",
        "APEX_FP_WEBGL_LINE_WIDTH_MAX": "1",  # mobile GLES; best-effort, test
    })
    args = [
        "--no-sandbox", "--disable-dev-shm-usage",
        "--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist",
        "--enable-webgl", "--enable-unsafe-swiftshader",
        "--no-first-run", "--no-default-browser-check",
    ]
    page = Path(tempfile.gettempdir()) / "apex_android.html"
    page.write_text("<!doctype html><html><body>x</body></html>")
    browser = await nodriver.start(
        browser_executable_path=os.environ["APEX_CHROME_PATH"],
        headless=False, sandbox=False, browser_args=args)
    try:
        tab = await browser.get(page.as_uri())
        await asyncio.sleep(0.8)
        # 1) read our REAL Chrome-149 brands + fullVersionList (never fabricate)
        raw = await tab.evaluate(
            "navigator.userAgentData.getHighEntropyValues(['fullVersionList'])"
            ".then(h => JSON.stringify({b: navigator.userAgentData.brands, f: h.fullVersionList}))",
            await_promise=True, return_by_value=True)
        s = raw if isinstance(raw, str) else _unwrap(raw)
        native = json.loads(s) if isinstance(s, str) else s
        brands = [cdp.emulation.UserAgentBrandVersion(brand=b["brand"], version=b["version"])
                  for b in native["b"]]
        fvl = [cdp.emulation.UserAgentBrandVersion(brand=b["brand"], version=b["version"])
               for b in native["f"]]
        meta = cdp.emulation.UserAgentMetadata(
            platform="Android", platform_version="14.0.0", architecture="",
            model="SM-S911B", mobile=True, brands=brands, full_version_list=fvl,
            bitness="", wow64=False, form_factors=["Mobile"])
        # 2) apply mobile emulation over CDP
        await tab.send(cdp.emulation.set_user_agent_override(
            user_agent=UA, accept_language="en-US,en;q=0.9",
            platform="Linux armv8l", user_agent_metadata=meta))
        await tab.send(cdp.emulation.set_device_metrics_override(
            width=360, height=780, device_scale_factor=3.0, mobile=True))
        await tab.send(cdp.emulation.set_touch_emulation_enabled(
            enabled=True, max_touch_points=5))
        # 3) navigate fresh so the page sees the emulated device from load
        tab = await browser.get(page.as_uri())
        await asyncio.sleep(1.0)
        raw = await tab.evaluate(PROBE, await_promise=True, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    finally:
        browser.stop()
    print("ANDROID_RESULT " + json.dumps(r, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
