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
import tempfile
from pathlib import Path

import nodriver
from stealth_browser.fp_profiles import PROFILES, fp_env
from stealth_browser.runner_nodriver import _unwrap

PROBE = r"""(async () => {
  let gl = document.createElement('canvas').getContext('webgl');
  let u = gl && gl.getExtension('WEBGL_debug_renderer_info');
  let lw = null;
  try { const r = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE); lw = r ? r[1] : null; } catch (e) {}
  let wgpuVendor = null, wgpuFallback = null, wgpuErr = null;
  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      if (a && a.info) { wgpuVendor = a.info.vendor; wgpuFallback = a.info.isFallbackAdapter; }
      else { wgpuErr = 'no adapter'; }
    } else { wgpuErr = 'no navigator.gpu'; }
  } catch (e) { wgpuErr = String(e); }
  return {
    platform: navigator.platform,
    uad: navigator.userAgentData ? navigator.userAgentData.platform : null,
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    sw: screen.width, sh: screen.height,
    webgl: u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : '',
    lineWidthMax: lw,
    wgpuVendor, wgpuFallback, wgpuErr,
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
        "--enable-unsafe-webgpu", "--enable-features=Vulkan",
        "--no-first-run", "--no-default-browser-check",
    ]
    # navigator.userAgentData is gated to secure contexts -- a data: URL is
    # NOT one (returns undefined), but file:// is treated as potentially
    # trustworthy, so the UA-CH platform check sees the spoofed value.
    page = Path(tempfile.gettempdir()) / "apex_probe.html"
    page.write_text("<!doctype html><html><body>x</body></html>")
    browser = await nodriver.start(
        browser_executable_path=os.environ["APEX_CHROME_PATH"],
        headless=False, sandbox=False, browser_args=args)
    try:
        tab = await browser.get(page.as_uri())
        await asyncio.sleep(1.5)
        raw = await tab.evaluate(PROBE, await_promise=True, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    finally:
        browser.stop()

    g = (r.get("webgl") or "").lower()
    gc = p.gpu_class
    gpu_ok = (
        (gc == "apple" and "apple" in g) or
        (gc == "nvidia" and "nvidia" in g) or
        (gc == "intel" and "intel" in g) or
        (gc == "amd" and ("amd" in g or "radeon" in g)) or
        (gc == "llvmpipe" and "llvmpipe" in g))
    plat_ok = (r.get("platform") == p.platform and
               r.get("uad") == p.ua_platform and
               r.get("cores") == p.hw_concurrency and
               r.get("sw") == p.screen_w)
    # the persona OS token must be in the UA (apex-ua-platform; Linux is native)
    osname = {"Windows": "Windows NT", "macOS": "Mac OS X",
              "Linux": "X11; Linux x86_64"}.get(p.ua_platform, "")
    ua_ok = osname in (r.get("ua") or "")
    # line-width coherence (apex-webgl-ranges): D3D11/Metal -> 1, but Mesa
    # llvmpipe (Linux software) genuinely reports 255 (measured).
    lw_ok = r.get("lineWidthMax") == (255 if gc == "llvmpipe" else 1)
    # WebGPU adapter must be present + vendor == gpu_class + not a fallback
    # (apex-webgpu-adapterinfo). Verifies WebGL<->WebGPU GPU agreement per
    # family (apple/nvidia/intel/amd), the 2025-26 cross-check. The llvmpipe
    # (GPU-less Linux) persona leaves WebGPU NATIVE -- Chrome's bundled
    # SwiftShader, vendor "google" -- which is the honest pairing for that box.
    if gc == "llvmpipe":
        wgpu_ok = (r.get("wgpuVendor") == "google")
    else:
        wgpu_ok = (r.get("wgpuVendor") == gc and r.get("wgpuFallback") is False)
    ok = plat_ok and gpu_ok and ua_ok and lw_ok and wgpu_ok
    wgpu_fb = "fb" if r.get("wgpuFallback") else "nofb"
    wgpu_detail = "" if wgpu_ok else f" (want {gc}) err={r.get('wgpuErr')!r}"
    print(f"RESULT [{'PASS' if ok else 'FAIL'}] {p.label[:30]:30} "
          f"plat={r.get('platform')} ua={r.get('uad')} cores={r.get('cores')} "
          f"scr={r.get('sw')} gpu={'ok' if gpu_ok else 'NO'} "
          f"uaTok={'ok' if ua_ok else 'NO'} lineWidth={r.get('lineWidthMax')} "
          f"wgpu={r.get('wgpuVendor')!r}/{wgpu_fb}{wgpu_detail}")


if __name__ == "__main__":
    asyncio.run(main())
