#!/usr/bin/env python3
"""Discover the launch-flag combo that gives WebGPU a software adapter.

The 149wgl binary already bundles SwiftShader's Vulkan ICD and the
apex-webgpu-adapterinfo patch, but our production launch flags never enable
WebGPU/Vulkan -- so navigator.gpu.requestAdapter() returns null. For a macOS
or Windows persona (OSes where Chrome ships WebGPU on by default) an absent
adapter is a coherence tell. This probe tries a matrix of flag/env combos one
browser per process and reports, for each: whether navigator.gpu exists,
whether an adapter came back (+ its vendor/arch/isFallback under our patch),
the WebGPU backend, AND the WebGL renderer + MAX_TEXTURE_SIZE -- because
enabling Vulkan must NOT knock WebGL off ANGLE-GL/llvmpipe (16384 coherent).

    APEX_CHROME_PATH=/path/to/chrome python webgpu_probe.py <combo-index>

webgpu_test.sh loops this over every combo so the wrapper can pick the winner:
the combo where an adapter is present, vendor=='apple' (patch fired),
isFallback==false, and maxTextureSize stays 16384.
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

# Base container flags (mirror profile.chrome_launch_flags' container branch).
BASE = [
    "--no-sandbox", "--disable-dev-shm-usage",
    "--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist",
    "--enable-webgl", "--enable-unsafe-swiftshader",
    "--no-first-run", "--no-default-browser-check",
]

# Each combo = (label, extra_flags, needs_icd_env). `needs_icd_env` points the
# Vulkan loader at the SwiftShader ICD bundled next to the chrome binary.
COMBOS = [
    ("control (base only)", [], False),
    ("unsafe-webgpu + Vulkan",
     ["--enable-unsafe-webgpu", "--enable-features=Vulkan"], False),
    ("unsafe-webgpu + Vulkan + ICD-env",
     ["--enable-unsafe-webgpu", "--enable-features=Vulkan"], True),
    ("unsafe-webgpu + Vulkan + ICD-env + dawn-allow",
     ["--enable-unsafe-webgpu", "--enable-features=Vulkan",
      "--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist"],
     True),
    ("unsafe-webgpu + Vulkan + ICD-env + vulkan-fallback-flags",
     ["--enable-unsafe-webgpu", "--enable-features=Vulkan",
      "--disable-vulkan-surface", "--enable-dawn-features=disable_adapter_blocklist"],
     True),
    ("use-vulkan=swiftshader + unsafe-webgpu + Vulkan + ICD-env",
     ["--enable-unsafe-webgpu", "--enable-features=Vulkan",
      "--use-vulkan=swiftshader"], True),
]

PROBE = r"""(async () => {
  let gl = document.createElement('canvas').getContext('webgl');
  let u = gl && gl.getExtension('WEBGL_debug_renderer_info');
  let webglRenderer = u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : '';
  let maxTex = null;
  try { maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE); } catch (e) {}
  let out = {
    gpuExists: !!navigator.gpu, adapter: false,
    vendor: null, architecture: null, isFallback: null,
    backend: null, err: null,
    webglRenderer, maxTex,
  };
  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      if (a) {
        out.adapter = true;
        const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
        if (info) {
          out.vendor = info.vendor; out.architecture = info.architecture;
          out.isFallback = info.isFallbackAdapter;
          out.backend = info.description || info.device || null;
        }
      } else { out.err = 'requestAdapter null'; }
    } else { out.err = 'no navigator.gpu'; }
  } catch (e) { out.err = String(e); }
  return out;
})()"""


async def main() -> None:
    idx = int(sys.argv[1])
    label, extra, needs_icd = COMBOS[idx]

    # Apple M1 persona -- WebGPU vendor should resolve to "apple" via the patch.
    p = next(x for x in PROFILES if x.gpu_class == "apple")
    for k in list(os.environ):
        if k.startswith("APEX_FP_"):
            del os.environ[k]
    os.environ.update(fp_env(p, 4242))

    chrome = os.environ["APEX_CHROME_PATH"]
    if needs_icd:
        icd = Path(chrome).resolve().parent / "vk_swiftshader_icd.json"
        os.environ["VK_ICD_FILENAMES"] = str(icd)
        os.environ["VK_DRIVER_FILES"] = str(icd)  # newer loader var name
    else:
        os.environ.pop("VK_ICD_FILENAMES", None)
        os.environ.pop("VK_DRIVER_FILES", None)

    page = Path(tempfile.gettempdir()) / "apex_webgpu.html"
    page.write_text("<!doctype html><html><body>x</body></html>")
    browser = await nodriver.start(
        browser_executable_path=chrome, headless=False, sandbox=False,
        browser_args=BASE + extra)
    try:
        tab = await browser.get(page.as_uri())
        await asyncio.sleep(2.0)
        raw = await tab.evaluate(PROBE, await_promise=True, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    finally:
        browser.stop()

    win = (r.get("adapter") and r.get("vendor") == "apple"
           and r.get("isFallback") is False and r.get("maxTex") == 16384)
    print(f"WGPU [{idx}] {'WIN ' if win else '    '} {label[:48]:48} "
          f"gpu={r.get('gpuExists')} adapter={r.get('adapter')} "
          f"vendor={r.get('vendor')!r} fallback={r.get('isFallback')} "
          f"maxTex={r.get('maxTex')} backend={r.get('backend')!r} "
          f"err={r.get('err')!r}")


if __name__ == "__main__":
    asyncio.run(main())
