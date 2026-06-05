#!/usr/bin/env python3
"""Measure the patched Chromium binary directly via CDP.

The SFN build only proves the binary COMPILES. This harness proves it actually
SPOOFS at runtime: it launches the patched binary with a known APEX_FP_* set,
evaluates every patched surface in-page, and asserts each reports the spoofed
value AND that Function.prototype.toString still says [native code] (the proof
that the patch is in C++, not a JS shim).

Run after fetching the artifact:
    APEX_CHROME_PATH=/opt/stealth-chromium/chrome \
      uv run --project ../stealth-browser python scripts/verify_patched_binary.py

Exits 0 only if every hard assertion passes. Prints a composite score (fraction
of measured surfaces that report the spoofed value).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import nodriver
from stealth_browser.runner_nodriver import _unwrap

HERE = Path(__file__).resolve().parent
VERIFY_HTML = HERE / "verify_patches.html"

# A known, internally-coherent identity. We assert the binary reports EXACTLY
# these. rtt=100 is chosen so Chrome's 50ms rounding (which the patch mirrors)
# is a no-op: ((100+25)/50)*50 == 100.
FP_ENV = {
    "APEX_FP_ACTIVE": "1",
    "APEX_FP_SEED": "4242",
    "APEX_FP_PLATFORM": "MacIntel",
    "APEX_FP_UA_PLATFORM": "macOS",
    "APEX_FP_HW_CONCURRENCY": "10",
    "APEX_FP_DEVICE_MEMORY": "8",
    "APEX_FP_WEBGL_VENDOR": "Google Inc. (Apple)",
    "APEX_FP_WEBGL_RENDERER": (
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, "
        "Unspecified Version)"
    ),
    "APEX_FP_SCREEN_W": "1512",
    "APEX_FP_SCREEN_H": "982",
    "APEX_FP_SCREEN_AVAIL_W": "1512",
    "APEX_FP_SCREEN_AVAIL_H": "944",
    "APEX_FP_COLOR_DEPTH": "24",
    "APEX_FP_BATTERY_LEVEL": "0.82",
    "APEX_FP_BATTERY_CHARGING": "0",
    "APEX_FP_NET_RTT": "100",
    "APEX_FP_NET_DOWNLINK": "10",
    "APEX_FP_NET_EFFECTIVE_TYPE": "4g",
    "APEX_FP_STORAGE_QUOTA": "137438953472",  # 128 GiB
}

# The JS payload returns a single JSON-able object with every surface + the
# toString integrity checks. Runs in-page after a short settle so the async
# surfaces (storage/battery/devices/voices) have resolved.
PROBE_JS = r"""
(async () => {
  const tsNative = (fn) => {
    try {
      return /\{\s*\[native code\]\s*\}/.test(
        Function.prototype.toString.call(fn));
    } catch (e) { return false; }
  };
  const navProto = Object.getPrototypeOf(navigator);
  const hwGetter =
    Object.getOwnPropertyDescriptor(navProto, 'hardwareConcurrency')?.get
    || Object.getOwnPropertyDescriptor(Navigator.prototype,
         'hardwareConcurrency')?.get;

  // canvas hash, twice, to confirm in-session stability
  const canvasHash = () => {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 30;
    const x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '14px Arial';
    x.fillStyle = '#069'; x.fillText('apex-fp-check', 2, 2);
    return c.toDataURL();
  };
  const h1 = canvasHash(), h2 = canvasHash();

  // webgl unmasked strings (may be unavailable with no GL — caught)
  let webglVendor = null, webglRenderer = null, webglErr = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl')
      || document.createElement('canvas').getContext('experimental-webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
    webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  } catch (e) { webglErr = String(e); }

  const conn = navigator.connection || null;

  let storage = null, storageErr = null;
  try {
    if (navigator.storage && navigator.storage.estimate)
      storage = await navigator.storage.estimate();
  } catch (e) { storageErr = String(e); }

  let battery = null;
  try { if (navigator.getBattery) battery = await navigator.getBattery(); }
  catch (e) {}

  let devices = null;
  try {
    if (navigator.mediaDevices?.enumerateDevices)
      devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {}

  // voices sometimes populate async
  let voices = speechSynthesis.getVoices();
  if (voices.length === 0) {
    await new Promise(r => setTimeout(r, 800));
    voices = speechSynthesis.getVoices();
  }

  return {
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform
                                        : null,
    screenW: screen.width, screenH: screen.height,
    availW: screen.availWidth, availH: screen.availHeight,
    colorDepth: screen.colorDepth,
    webglVendor, webglRenderer, webglErr,
    connEffectiveType: conn ? conn.effectiveType : null,
    connRtt: conn ? conn.rtt : null,
    connDownlink: conn ? conn.downlink : null,
    storageQuota: storage ? storage.quota : null,
    storageUsage: storage ? storage.usage : null,
    storageErr,
    batteryLevel: battery ? battery.level : null,
    batteryCharging: battery ? battery.charging : null,
    deviceCount: devices ? devices.length : null,
    voiceCount: voices.length,
    canvasStable: h1 === h2,
    clientRectStable: (() => {
      const a = document.body.getBoundingClientRect();
      const b = document.body.getBoundingClientRect();
      return a.width === b.width && a.x === b.x && a.height === b.height;
    })(),
    ts: {
      hardwareConcurrency: tsNative(hwGetter),
      screenWidth: tsNative(
        Object.getOwnPropertyDescriptor(Screen.prototype, 'width')?.get),
      toDataURL: tsNative(HTMLCanvasElement.prototype.toDataURL),
      getImageData: tsNative(
        CanvasRenderingContext2D.prototype.getImageData),
      glGetParameter: tsNative(
        WebGLRenderingContext.prototype.getParameter),
      getChannelData: tsNative(AudioBuffer.prototype.getChannelData),
    },
  };
})()
"""


def _check(results: list, ok: bool, label: str, got, want=None) -> None:
    detail = f"  (got={got!r}" + (f" want={want!r}" if want is not None else "") + ")"
    results.append((ok, label, "" if ok else detail))


async def run() -> int:
    bin_path = os.environ.get("APEX_CHROME_PATH")
    if not bin_path or not Path(bin_path).exists():
        print(f"ERROR: APEX_CHROME_PATH not set or missing: {bin_path!r}")
        return 2
    os.environ.update(FP_ENV)

    args = [
        "--no-sandbox", "--disable-dev-shm-usage",
        "--headless=new", "--disable-gpu",
        "--enable-unsafe-swiftshader",
        "--no-first-run", "--no-default-browser-check",
    ]
    print(f"=== verify_patched_binary: {bin_path} ===")
    browser = await nodriver.start(
        browser_executable_path=bin_path, headless=True, browser_args=args)
    try:
        tab = await browser.get(VERIFY_HTML.as_uri())
        await asyncio.sleep(1.5)
        raw = await tab.evaluate(PROBE_JS, await_promise=True,
                                 return_by_value=True)
    finally:
        browser.stop()

    # nodriver returns a deep-serialized RemoteObject for object results;
    # _unwrap (the same helper core_nodriver uses) normalizes it to a dict.
    r = raw if isinstance(raw, dict) else _unwrap(raw)
    if not isinstance(r, dict) or not r:
        print(f"ERROR: probe returned no usable dict: {raw!r}")
        return 2
    print("--- raw probe ---")
    print(json.dumps(r, indent=2)[:2000])

    results: list = []
    _check(results, r["platform"] == "MacIntel", "navigator.platform",
           r["platform"], "MacIntel")
    _check(results, r["hardwareConcurrency"] == 10,
           "navigator.hardwareConcurrency", r["hardwareConcurrency"], 10)
    _check(results, r["deviceMemory"] == 8, "navigator.deviceMemory",
           r["deviceMemory"], 8)
    _check(results, r["uaPlatform"] == "macOS",
           "userAgentData.platform", r["uaPlatform"], "macOS")
    _check(results, r["screenW"] == 1512 and r["screenH"] == 982,
           "screen.width/height", f'{r["screenW"]}x{r["screenH"]}', "1512x982")
    _check(results, r["availW"] == 1512 and r["availH"] == 944,
           "screen.avail*", f'{r["availW"]}x{r["availH"]}', "1512x944")
    _check(results, r["colorDepth"] == 24, "screen.colorDepth",
           r["colorDepth"], 24)
    # --- NEW surfaces (this build's quick wins) ---
    _check(results, r["connEffectiveType"] == "4g",
           "connection.effectiveType", r["connEffectiveType"], "4g")
    _check(results, r["connRtt"] == 100, "connection.rtt", r["connRtt"], 100)
    _check(results, r["connDownlink"] == 10, "connection.downlink",
           r["connDownlink"], 10)
    _check(results, r["storageQuota"] == 137438953472,
           "storage.estimate().quota", r["storageQuota"], 137438953472)
    # --- battery / lists ---
    _check(results, r["batteryLevel"] == 0.82, "battery.level",
           r["batteryLevel"], 0.82)
    _check(results, r["batteryCharging"] is False, "battery.charging",
           r["batteryCharging"], False)
    _check(results, (r["deviceCount"] or 0) > 0,
           "mediaDevices.enumerateDevices count", r["deviceCount"])
    _check(results, r["voiceCount"] > 0, "speechSynthesis voices",
           r["voiceCount"])
    _check(results, r["canvasStable"] is True,
           "canvas hash stable in-session", r["canvasStable"])
    _check(results, r["clientRectStable"] is True,
           "clientRect stable in-session (deterministic jitter)",
           r["clientRectStable"])
    # --- toString native-code integrity (the decisive check) ---
    for k, v in r["ts"].items():
        _check(results, v is True, f"toString native: {k}", v, True)

    # WebGL: a soft check — a GL-less container can legitimately fail to make a
    # context. If a context WAS made, the override MUST apply (hard).
    webgl_hard = None
    if r["webglErr"] is None and r["webglRenderer"] is not None:
        webgl_hard = (r["webglRenderer"] == FP_ENV["APEX_FP_WEBGL_RENDERER"]
                      and r["webglVendor"] == FP_ENV["APEX_FP_WEBGL_VENDOR"])
        _check(results, webgl_hard, "WebGL UNMASKED vendor/renderer",
               (r["webglVendor"], r["webglRenderer"]),
               (FP_ENV["APEX_FP_WEBGL_VENDOR"],
                FP_ENV["APEX_FP_WEBGL_RENDERER"]))
    else:
        print(f"\n[WebGL SKIP] no GL context in this container "
              f"(err={r['webglErr']}) — patch fires inside getParameter; "
              f"untestable without GL, not a patch failure.")

    print("\n--- assertions ---")
    passed = 0
    for ok, label, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}{detail}")
        passed += 1 if ok else 0
    total = len(results)
    score = passed / total if total else 0.0
    print(f"\ncomposite: {passed}/{total} surfaces spoofed correctly "
          f"= {score:.3f}")
    failed = total - passed
    if failed:
        print(f"VERDICT: {failed} FAILED — binary does not fully spoof.")
        return 1
    print("VERDICT: ALL CLEAN — patched binary spoofs every measured surface, "
          "zero JS-visible tampering.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
