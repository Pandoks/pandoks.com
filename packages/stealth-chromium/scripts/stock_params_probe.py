#!/usr/bin/env python3
"""Dump STOCK (unspoofed) WebGL + WebGPU params our llvmpipe host reports.

Zero spoofing (no APEX_FP_*), so every value is the GROUND TRUTH our actual
Linux/Mesa-llvmpipe renderer emits -- the verified basis for a coherent
llvmpipe-on-Linux persona (renderer string, line-width/point-size ranges,
max texture size, WebGPU vendor/limits). No guessing: these are measured.

    APEX_CHROME_PATH=/path/to/chrome python stock_params_probe.py
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

import nodriver
from stealth_browser.runner_nodriver import _unwrap

DUMP = r"""(async () => {
  const gl = document.createElement('canvas').getContext('webgl');
  const u = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const lw = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
  const ps = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const gl2 = document.createElement('canvas').getContext('webgl2');
  let wgpu = null;
  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      if (a) {
        const info = a.info || {};
        wgpu = {vendor: info.vendor, architecture: info.architecture,
                maxTextureDimension2D: a.limits.maxTextureDimension2D,
                isFallback: a.isFallbackAdapter};
      }
    }
  } catch (e) { wgpu = {err: String(e)}; }
  return {
    platform: navigator.platform,
    uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    webglVendor: gl.getParameter(gl.VENDOR),
    webglRenderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor: u ? gl.getParameter(u.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : null,
    aliasedLineWidth: lw ? [lw[0], lw[1]] : null,
    aliasedPointSize: ps ? [ps[0], ps[1]] : null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    webgl2: !!gl2,
    webgpu: wgpu,
  };
})()"""


async def main() -> None:
    for k in list(os.environ):
        if k.startswith("APEX_FP_"):
            del os.environ[k]
    args = [
        "--no-sandbox", "--disable-dev-shm-usage",
        "--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist",
        "--enable-webgl", "--enable-unsafe-swiftshader",
        "--enable-unsafe-webgpu", "--enable-features=Vulkan",
        "--no-first-run", "--no-default-browser-check",
    ]
    page = Path(tempfile.gettempdir()) / "apex_stock.html"
    page.write_text("<!doctype html><html><body>x</body></html>")
    browser = await nodriver.start(
        browser_executable_path=os.environ["APEX_CHROME_PATH"],
        headless=False, sandbox=False, browser_args=args)
    try:
        tab = await browser.get(page.as_uri())
        await asyncio.sleep(1.5)
        raw = await tab.evaluate(DUMP, await_promise=True, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    finally:
        browser.stop()
    print("STOCK_PARAMS " + json.dumps(r, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
