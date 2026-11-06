#!/usr/bin/env python3
"""WebGPU fingerprint probe -- first patch of the WebGPU subsystem.

Runs against the stealth-browser service (default http://localhost:41000) the
same way scripts/adversarial.py drives it: POST /sessions -> navigate ->
eval. Two phases:

  1. adapter identity  -- everything a GPU-adapter fingerprinter reads:
     GPUAdapterInfo (vendor/architecture/device/description), GPUBackendType
     (adapter.type), isFallbackAdapter/isCompatibilityMode, the features set,
     and the full limits table (adapter + device).
  2. cross-origin compile-state leak -- compile the SAME WGSL compute shader
     on origin A, navigate to a DIFFERENT origin, and time the first compile
     there. The 2026 measurement study (detection-sota-2026.md: "persistent
     pipeline compilation state" leaks across origins) and WebGPU-SPY both
     fingerprint on this; if the second origin's first compile is cache-fast,
     compile state crossed the origin boundary.

Usage: python3 webgpu_probe.py [--base http://localhost:41000]
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request

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
      const dfs = device.features ? Array.from(device.features).sort() : null;
      out.deviceFeatures = dfs;
    } catch (e) { out.deviceError = String(e); }
  } catch (e) { out.error = String(e); }
  return out;
})()
"""

# Same WGSL on every phase. Enough unrolled math that the first compile is
# measurable (~100+ ms of translate/SPIRV work), and deterministic.
WGSL = """
struct S { a: u32 }
@group(0) @binding(0) var<storage, read_write> buf: array<u32>;
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  var x: u32 = gid.x;
  """ + "\n".join(f"  x = x * 1664525u + {i * 1013904223 + 12345}u;" for i in range(256)) + """
  buf[gid.x] = x;
}
"""

COMPILE_PROBE = r"""
(async (wgsl) => {
  const t0 = performance.now();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return {noAdapter: true};
  const device = await adapter.requestDevice();
  const err = [];
  device.addEventListener('uncapturederror', (e) => err.push(String(e.error && e.error.message || e)));
  const module = device.createShaderModule({code: wgsl});
  const t1 = performance.now();
  const t2 = performance.now();
  await device.createComputePipelineAsync({
    layout: 'auto',
    compute: {module, entryPoint: 'main'},
  });
  const t3 = performance.now();
  return {moduleMs: +(t1 - t0).toFixed(1), compileMs: +(t3 - t2).toFixed(1),
          errors: err};
})"""


def api(base: str, method: str, path: str, body: dict | None = None,
        timeout: float = 180):
    req = urllib.request.Request(base + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    else:
        data = None
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def evaluate(base: str, sid: str, expression: str):
    status, res = api(base, "POST", f"/sessions/{sid}/eval",
                      body={"expression": expression})
    if status != 200 or not isinstance(res, dict):
        raise RuntimeError(f"eval failed: {status} {res}")
    result = res.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, TypeError):
            pass
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:41000")
    ap.add_argument("--profile", default=None,
                    help="persona substring to pin (passed to POST /sessions)")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    body = {} if not args.profile else {"profile": args.profile}
    status, created = api(base, "POST", "/sessions", body=body)
    if status not in (200, 201) or not isinstance(created, dict):
        print(f"FAIL: session create failed: {status} {created}")
        return 1
    sid = created["id"]
    print(f"session: {sid}")
    print("persona served:", json.dumps(created.get("profile"), indent=2))
    try:
        # --- phase 1: adapter identity on origin A -------------------------
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": "https://example.com/"})
        if status != 200:
            print(f"FAIL: navigate failed: {status}")
            return 1
        print("\n=== ADAPTER IDENTITY (origin: https://example.com) ===")
        print(json.dumps(evaluate(base, sid, ADAPTER_PROBE), indent=2))

        # --- phase 2: compile-state leak across origins ---------------------
        # warm nothing: measure the FIRST compile on origin A, then a SECOND
        # compile on A (same origin: cache hit expected), then navigate to a
        # different origin and measure its FIRST compile.
        for label in ("first", "second"):
            r = evaluate(base, sid, f"({COMPILE_PROBE})({json.dumps(WGSL)})")
            print(f"origin A ({label} same-origin compile): {r}")
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": "https://example.org/"})
        if status != 200:
            print(f"FAIL: navigate to origin B failed: {status}")
            return 1
        r = evaluate(base, sid, f'({COMPILE_PROBE})({json.dumps(WGSL)})')
        print(f"origin B (first compile, DIFFERENT origin): {r}")
    finally:
        api(base, "DELETE", f"/sessions/{sid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
