#!/usr/bin/env python3
"""Dump the FULL WebGPU adapter surface our patched Chrome exposes.

apex-webgpu-adapterinfo only spoofs vendor/architecture/isFallbackAdapter --
the ~40 numeric adapter.limits and the adapter.features set are raw
SwiftShader, IDENTICAL across every persona (the patch never touches them).
Two possible tells: (a) SwiftShader's limits match no real GPU, and (b) an
Apple persona and an NVIDIA persona report the SAME limits. This dumps
everything so we can compare against real per-family hardware and decide what
to spoof.

    APEX_CHROME_PATH=/path/to/chrome python webgpu_limits_probe.py [profile_idx]
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

import nodriver
from stealth_browser.fp_profiles import PROFILES, fp_env
from stealth_browser.runner_nodriver import _unwrap

DUMP = r"""(async () => {
  if (!navigator.gpu) return {err: 'no navigator.gpu'};
  const a = await navigator.gpu.requestAdapter();
  if (!a) return {err: 'no adapter'};
  const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
  const limits = {};
  // adapter.limits is a GPUSupportedLimits -- iterate the prototype keys.
  for (const k in a.limits) { try { limits[k] = a.limits[k]; } catch(e){} }
  // Some impls only expose via getPrototypeOf walk:
  let proto = Object.getPrototypeOf(a.limits);
  while (proto) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === 'constructor') continue;
      try { const v = a.limits[k]; if (typeof v === 'number') limits[k] = v; } catch(e){}
    }
    proto = Object.getPrototypeOf(proto);
  }
  const feats = [];
  try { for (const f of a.features) feats.push(f); } catch(e){}
  let wgsl = [];
  try { for (const f of navigator.gpu.wgslLanguageFeatures) wgsl.push(f); } catch(e){}
  return {
    vendor: info.vendor, architecture: info.architecture,
    device: info.device, description: info.description,
    isFallback: a.isFallbackAdapter,
    preferredFormat: navigator.gpu.getPreferredCanvasFormat(),
    limits, features: feats.sort(), wgsl: wgsl.sort(),
  };
})()"""


async def main() -> None:
    idx = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    p = PROFILES[idx]
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
    page = Path(tempfile.gettempdir()) / "apex_wgpu.html"
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
    print(f"=== WebGPU dump for profile[{idx}] {p.label} (gpu_class={p.gpu_class}) ===")
    print(json.dumps(r, indent=2, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
