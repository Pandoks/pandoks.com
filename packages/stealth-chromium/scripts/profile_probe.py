#!/usr/bin/env python3
"""Verify ONE fp_profile (by index) reports coherently at runtime.

One browser per process (the container's nodriver gets flaky launching many in
one process). full_test.sh loops this over every profile so each is checked in
isolation. Prints `RESULT [PASS|FAIL] <label> ...` so the wrapper can tally.

    APEX_CHROME_PATH=/path/to/chrome python profile_probe.py <index>
"""
from __future__ import annotations

import asyncio
import os
import sys

import nodriver
from stealth_browser.fp_profiles import PROFILES, fp_env
from stealth_browser.runner_nodriver import _unwrap

PROBE = r"""(() => {
  let gl = document.createElement('canvas').getContext('webgl');
  let u = gl && gl.getExtension('WEBGL_debug_renderer_info');
  let lw = null;
  try { const r = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE); lw = r ? r[1] : null; } catch (e) {}
  return {
    platform: navigator.platform,
    uad: navigator.userAgentData ? navigator.userAgentData.platform : null,
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    sw: screen.width, sh: screen.height,
    webgl: u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : '',
    lineWidthMax: lw,
  };
})()"""


async def main() -> None:
    p = PROFILES[int(sys.argv[1])]
    for k in list(os.environ):
        if k.startswith("APEX_FP_"):
            del os.environ[k]
    os.environ.update(fp_env(p, 4242))
    args = [
        "--no-sandbox", "--disable-dev-shm-usage",
        "--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist",
        "--enable-webgl", "--enable-unsafe-swiftshader",
        "--no-first-run", "--no-default-browser-check",
    ]
    browser = await nodriver.start(
        browser_executable_path=os.environ["APEX_CHROME_PATH"],
        headless=False, sandbox=False, browser_args=args)
    try:
        tab = await browser.get("data:text/html,<html><body>x</body></html>")
        await asyncio.sleep(1.0)
        raw = await tab.evaluate(PROBE, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    finally:
        browser.stop()

    g = (r.get("webgl") or "").lower()
    gc = p.gpu_class
    gpu_ok = (
        (gc == "apple" and "apple" in g) or
        (gc == "nvidia" and "nvidia" in g) or
        (gc == "intel" and "intel" in g) or
        (gc == "amd" and ("amd" in g or "radeon" in g)))
    plat_ok = (r.get("platform") == p.platform and
               r.get("uad") == p.ua_platform and
               r.get("cores") == p.hw_concurrency and
               r.get("sw") == p.screen_w)
    # the persona OS token must be in the UA (apex-ua-platform)
    osname = "Windows NT" if p.ua_platform == "Windows" else "Mac OS X"
    ua_ok = osname in (r.get("ua") or "")
    # line-width coherence (apex-webgl-ranges): D3D/Metal -> max 1
    lw_ok = r.get("lineWidthMax") == 1
    ok = plat_ok and gpu_ok and ua_ok and lw_ok
    print(f"RESULT [{'PASS' if ok else 'FAIL'}] {p.label[:30]:30} "
          f"plat={r.get('platform')} ua={r.get('uad')} cores={r.get('cores')} "
          f"scr={r.get('sw')} gpu={'ok' if gpu_ok else 'NO'} "
          f"uaTok={'ok' if ua_ok else 'NO'} lineWidth={r.get('lineWidthMax')}")


if __name__ == "__main__":
    asyncio.run(main())
