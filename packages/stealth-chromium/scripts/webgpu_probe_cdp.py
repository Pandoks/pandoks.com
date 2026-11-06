#!/usr/bin/env python3
"""WebGPU raw-CDP probe of a stealth-chromium binary (no automation framework).

Launches the binary itself with WebGPU enabled and reads every GPU-adapter
fingerprint surface over the DevTools WebSocket -- the same surface list the
2026 measurement study says detectors use: GPUAdapterInfo, GPUBackendType,
features, limits, plus the cross-origin pipeline-compile-state leak.

Runs where the binary runs (in the container the `websockets` pip package is
available; on a build host install it first). Two modes:

  --no-fp : launch with NO APEX_FP_* env  -> what the stock binary leaks
  --fp    : launch with the APEX_FP_* env the persona layer emits (the intel
            profile values, since the container host is GPU-class intel)
            -> what the patched binary presents

Usage: python3 webgpu_probe_cdp.py --binary /opt/stealth-chromium/chrome --fp
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import time
import urllib.request
import websockets

PORT = 9600

# The WGSL must be identical between phases so the compile cache can hit it.
WGSL = ("struct S { a: u32 }\n"
        "@group(0) @binding(0) var<storage, read_write> buf: array<u32>;\n"
        "@compute @workgroup_size(64, 1, 1)\n"
        "fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n"
        "  var x: u32 = gid.x;\n"
        + "".join(f"  x = x * 1664525u + {i * 1013904223 + 12345}u;\n"
                  for i in range(256))
        + "  buf[gid.x] = x;\n"
        "}\n")

ADAPTER_PROBE = r"""
(async () => {
  const out = {hasGPU: typeof navigator.gpu !== 'undefined'};
  if (!out.hasGPU) return out;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) { out.noAdapter = true; return out; }
    out.info = {};
    if (adapter.info) {
      for (const k of ['vendor','architecture','device','description'])
        out.info[k] = adapter.info[k] === undefined ? null : adapter.info[k];
    } else out.noInfo = true;
    out.type = adapter.type === undefined ? null : adapter.type;
    out.isFallbackAdapter = adapter.isFallbackAdapter;
    out.isCompatibilityMode = adapter.isCompatibilityMode === undefined ?
        null : adapter.isCompatibilityMode;
    out.features = adapter.features ? Array.from(adapter.features).sort() : null;
    out.adapterLimits = {};
    if (adapter.limits)
      for (const k in adapter.limits) out.adapterLimits[k] = adapter.limits[k];
    try {
      const device = await adapter.requestDevice();
      out.deviceLimits = {};
      if (device.limits)
        for (const k in device.limits) out.deviceLimits[k] = device.limits[k];
      out.deviceFeatures = device.features ? Array.from(device.features).sort()
                                           : null;
    } catch (e) { out.deviceError = String(e); }
  } catch (e) { out.error = String(e); }
  return out;
})()
"""

COMPILE_PROBE = r"""
(async (wgsl) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return {noAdapter: true};
  const device = await adapter.requestDevice();
  const t0 = performance.now();
  const module = device.createShaderModule({code: wgsl});
  const t1 = performance.now();
  await device.createComputePipelineAsync({
    layout: 'auto', compute: {module, entryPoint: 'main'},
  });
  const t2 = performance.now();
  return {moduleMs: +(t1 - t0).toFixed(1), compileMs: +(t2 - t1).toFixed(1)};
})"""


class CDP:
    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        self.n = 0
        self.ws = None

    async def __aenter__(self):
        self.ws = await websockets.connect(self.ws_url, open_timeout=20)
        return self

    async def __aexit__(self, *exc):
        await self.ws.close()

    async def ev(self, expr: str):
        self.n += 1
        await self.ws.send(json.dumps({
            "id": self.n, "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": True,
                       "awaitPromise": True}}))
        while True:
            m = json.loads(await self.ws.recv())
            if m.get("id") == self.n:
                res = m.get("result", {}).get("result", {})
                if res.get("type") == "exceptionDetails":
                    return {"exception": res}
                return res.get("value")

    async def nav(self, url: str):
        self.n += 1
        await self.ws.send(json.dumps({
            "id": self.n, "method": "Page.navigate", "params": {"url": url}}))
        while json.loads(await self.ws.recv()).get("id") != self.n:
            pass
        await _wait(4)


async def _wait(s: float):
    await __import__("asyncio").sleep(s)


async def run_probe(binary: str, fp_env: dict, extra_flags=None) -> None:
    profile = tempfile.mkdtemp(prefix="wgpu-cdp-")
    env = {**os.environ, **fp_env}
    args = [binary, "--headless=new", "--no-sandbox",
            f"--user-data-dir={profile}", f"--remote-debugging-port={PORT}",
            "--remote-allow-origins=*", "--enable-unsafe-webgpu",
            "--use-angle=swiftshader"] + list(extra_flags or []) + \
        ["https://example.com/"]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env=env)
    try:
        ws_url = None
        for _ in range(120):
            await _wait(0.5)
            try:
                with urllib.request.urlopen(
                        f"http://localhost:{PORT}/json", timeout=2) as r:
                    pages = [t for t in json.load(r) if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                continue
        if not ws_url:
            print("FAIL: no DevTools endpoint")
            return
        async with CDP(ws_url) as cdp:
            print("=== ADAPTER IDENTITY (origin: example.com) ===")
            print(json.dumps(await cdp.ev(ADAPTER_PROBE), indent=2))
            print("=== COMPILE TIMING (same WGSL) ===")
            for label in ("A-first", "A-second"):
                r = await cdp.ev(f"({COMPILE_PROBE})({json.dumps(WGSL)})")
                print(f"  origin A {label}: {r}")
            await cdp.nav("https://example.org/")
            r = await cdp.ev(f"({COMPILE_PROBE})({json.dumps(WGSL)})")
            print(f"  origin B first (DIFFERENT origin): {r}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        import shutil
        shutil.rmtree(profile, ignore_errors=True)


# The persona env the stealth-browser layer emits for a GPU-class-"intel" host
# (fp_profiles.fp_env -> core_patchright launches the binary with it). Mirrors
# the "Windows laptop, Intel Iris Xe" persona exactly: identity + type + the
# class limits + the intel feature allowlist + the media-capability overrides,
# so --fp exercises every APEX_FP_* injection point. Battery is the
# seed-derived laptop value (fp_env('...Iris Xe', seed=13371337)).
FP_INTEL = {
    "APEX_FP_ACTIVE": "1",
    "APEX_FP_SEED": "13371337",
    "APEX_FP_PLATFORM": "Win32",
    "APEX_FP_UA_PLATFORM": "Windows",
    "APEX_FP_CANVAS_KEY": "16924706725946048579",
    "APEX_FP_UA_ARCH": "x86",
    "APEX_FP_UA_PLATFORM_VERSION": "15.0.0",
    "APEX_FP_HW_CONCURRENCY": "8",
    "APEX_FP_DEVICE_MEMORY": "8",
    "APEX_FP_WEBGL_VENDOR": "Google Inc. (Intel)",
    "APEX_FP_WEBGL_RENDERER": "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics "
                              "(0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "APEX_FP_WEBGPU_VENDOR": "intel",
    "APEX_FP_WEBGPU_ARCH": "gen-12lp",
    "APEX_FP_WEBGPU_DEVICE_ID": "0x46a6",
    "APEX_FP_WEBGPU_DESCRIPTION": "Intel(R) Iris(R) Xe Graphics",
    "APEX_FP_WEBGPU_DRIVER": "D3D12",
    "APEX_FP_WEBGPU_TYPE": "integrated",
    "APEX_FP_NETINFO_EFFECTIVE_TYPE": "4g",
    "APEX_FP_NETINFO_RTT_MS": "50",
    "APEX_FP_NETINFO_DOWNLINK_KBPS": "12000",
    "APEX_FP_WEBGPU_LIMIT_maxTextureDimension1D": "16384",
    "APEX_FP_WEBGPU_LIMIT_maxTextureDimension2D": "16384",
    "APEX_FP_WEBGPU_LIMIT_maxTextureDimension3D": "2048",
    "APEX_FP_WEBGPU_LIMIT_maxTextureArrayLayers": "2048",
    "APEX_FP_WEBGPU_LIMIT_maxBindGroups": "8",
    "APEX_FP_WEBGPU_LIMIT_maxBindGroupsPlusVertexBuffers": "40",
    "APEX_FP_WEBGPU_LIMIT_maxComputeInvocationsPerWorkgroup": "1024",
    "APEX_FP_WEBGPU_LIMIT_maxComputeWorkgroupSizeX": "1024",
    "APEX_FP_WEBGPU_LIMIT_maxComputeWorkgroupSizeY": "1024",
    "APEX_FP_WEBGPU_LIMIT_maxComputeWorkgroupSizeZ": "1024",
    "APEX_FP_WEBGPU_LIMIT_maxComputeWorkgroupStorageSize": "32768",
    "APEX_FP_WEBGPU_LIMIT_maxBufferSize": "4294967296",
    "APEX_FP_WEBGPU_LIMIT_maxStorageBufferBindingSize": "4294967296",
    "APEX_FP_WEBGPU_FEATURES": ("core-features-and-limits,"
                                "depth-clip-control,depth32float-stencil8,"
                                "timestamp-query,indirect-first-instance,"
                                "rg11b10ufloat-renderable,bgra8unorm-storage,"
                                "float32-filterable,float32-blendable,"
                                "dual-source-blending,clip-distances,"
                                "texture-compression-bc"),
    "APEX_FP_MEDIA_HW_DECODE": "1",
    "APEX_FP_MEDIA_HW_ENCODE": "1",
    "APEX_FP_MEDIA_HEVC": "1",
    "APEX_FP_MEDIA_DOLBY_VISION": "1",
    "APEX_FP_BATTERY_LEVEL": "0.92",
    "APEX_FP_BATTERY_CHARGING": "0",
}


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--fp", action="store_true",
                    help="launch with the intel-persona APEX_FP_* env")
    ap.add_argument("--flags", default="",
                    help="comma-separated extra chrome flags")
    args = ap.parse_args()
    env = FP_INTEL if args.fp else {}
    label = ("WITH persona env (patch path)" if args.fp
             else "NO persona env (stock path)")
    print(f"=== {args.binary} -- {label} ===")
    await run_probe(args.binary, env, [f for f in args.flags.split(",") if f])
    return 0


if __name__ == "__main__":
    import asyncio
    raise SystemExit(asyncio.run(main()))
