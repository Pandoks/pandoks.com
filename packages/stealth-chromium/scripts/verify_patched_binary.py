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
    "APEX_FP_UA_PLATFORM_VERSION": "14.6.0",
    "APEX_FP_HW_CONCURRENCY": "10",
    "APEX_FP_DEVICE_MEMORY": "8",
    "APEX_FP_WEBGL_VENDOR": "Google Inc. (Apple)",
    "APEX_FP_WEBGL_RENDERER": (
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, "
        "Unspecified Version)"
    ),
    "APEX_FP_WEBGPU_VENDOR": "apple",      # coherent with the WebGL GPU above
    "APEX_FP_WEBGPU_ARCHITECTURE": "",
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

  // --- noise surfaces (compared spoof-on vs stock by the runner) ---
  // measureText sub-pixel width -- farbling moves it off the stock grid value.
  let measureTextW = null;
  try {
    const mc = document.createElement('canvas').getContext('2d');
    mc.font = '16px Arial';
    measureTextW = mc.measureText('apex 0123456789 the quick brown fox').width;
  } catch (e) {}
  // OfflineAudioContext render hash -- THE canonical audio fingerprint path.
  let audioHash = null;
  try {
    const ac = new OfflineAudioContext(1, 44100, 44100);
    const osc = ac.createOscillator(); osc.type = 'triangle';
    osc.frequency.value = 440;
    const comp = ac.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ac.destination); osc.start(0);
    const rb = await ac.startRendering();
    const d = rb.getChannelData(0);
    let s = 0; for (let i = 4000; i < 6000; i++) { s += Math.abs(d[i]); }
    audioHash = s.toFixed(10);
  } catch (e) { audioHash = 'err'; }
  // REALTIME AudioContext internals -- browserscan flags "Audio is not
  // functioning properly" when the live context is suspended / has no output
  // device. Capture state/sampleRate to tell a no-audio-device env from the
  // farbling.
  let audioRtState = null, audioSampleRate = null, audioBaseLatency = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const rt = new AC();
    audioRtState = rt.state;
    audioSampleRate = rt.sampleRate;
    audioBaseLatency = (typeof rt.baseLatency === 'number') ? rt.baseLatency : null;
    try { rt.close(); } catch (e) {}
  } catch (e) { audioRtState = 'err:' + String(e).slice(0, 40); }
  // canvas.toBlob() -- a DIFFERENT encode path from toDataURL; must also farble.
  let blobHash = null;
  try {
    const bc = document.createElement('canvas'); bc.width = 120; bc.height = 40;
    const bx = bc.getContext('2d');
    bx.fillStyle = '#3a7'; bx.fillRect(0, 0, 120, 40);
    bx.fillStyle = '#a33'; bx.font = '14px Arial'; bx.fillText('apex-blob', 4, 22);
    const blob = await new Promise(r => bc.toBlob(r));
    const u = new Uint8Array(await blob.arrayBuffer());
    let bh = 0; for (let i = 0; i < u.length; i += 13) { bh = (bh * 31 + u[i]) >>> 0; }
    blobHash = bh;
  } catch (e) { blobHash = 'err'; }
  const h1 = canvasHash(), h2 = canvasHash();

  // webgl unmasked strings + the numeric caps that must agree with the GPU the
  // string claims (MAX_TEXTURE_SIZE driver-IDs hardware at ~91% accuracy).
  let webglVendor = null, webglRenderer = null, webglErr = null;
  let maxTextureSize = null, maxRenderbufferSize = null, maxViewportDim = null, aliasedLineWidthMax = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl')
      || document.createElement('canvas').getContext('experimental-webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
    webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    maxViewportDim = vp ? vp[0] : null;
    const lw = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
    aliasedLineWidthMax = lw ? lw[1] : null;
  } catch (e) { webglErr = String(e); }

  // UA-CH high-entropy platform/version -- comes from the SAME UserAgentMetadata
  // that fills the Sec-CH-UA-Platform[-Version] request headers, so this checks
  // header coherence from JS.
  let uachPlatform = null, uachPlatformVersion = null, uaBrands = null;
  try {
    if (navigator.userAgentData) {
      const hev = await navigator.userAgentData.getHighEntropyValues(
        ['platform', 'platformVersion']);
      uachPlatform = hev.platform;
      uachPlatformVersion = hev.platformVersion;
      uaBrands = (navigator.userAgentData.brands || []).map(b => b.brand);
    }
  } catch (e) {}

  // WebGPU adapter info — detectors cross-check this against the WebGL GPU.
  // On a headless box this is a SwiftShader fallback adapter; the patch
  // overrides vendor and forces isFallbackAdapter=false.
  let webgpuVendor = null, webgpuArchitecture = null,
      webgpuIsFallback = null, webgpuErr = null,
      webgpuMaxTex2D = null, webgpuHasAstc = null;
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter && adapter.info) {
        webgpuVendor = adapter.info.vendor;
        webgpuArchitecture = adapter.info.architecture;
        webgpuIsFallback = adapter.info.isFallbackAdapter;
        webgpuMaxTex2D = adapter.limits.maxTextureDimension2D;
        webgpuHasAstc = adapter.features.has('texture-compression-astc');
      } else { webgpuErr = 'no adapter'; }
    } else { webgpuErr = 'no navigator.gpu'; }
  } catch (e) { webgpuErr = String(e); }

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
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    uaBrands,
    uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform
                                        : null,
    uachPlatform, uachPlatformVersion,
    screenW: screen.width, screenH: screen.height,
    availW: screen.availWidth, availH: screen.availHeight,
    colorDepth: screen.colorDepth,
    webglVendor, webglRenderer, webglErr,
    maxTextureSize, maxRenderbufferSize, maxViewportDim,
    webgpuVendor, webgpuArchitecture, webgpuIsFallback, webgpuErr,
    webgpuMaxTex2D, webgpuHasAstc,
    measureTextW, audioHash, audioRtState, audioSampleRate, audioBaseLatency,
    audioOutCount: devices ? devices.filter(d => d.kind === 'audiooutput').length : null,
    blobHash, canvasTail: (canvasHash() || '').slice(-24),
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


async def _probe(bin_path: str, spoof: bool) -> dict:
    """Launch the binary once and run PROBE_JS. spoof=True applies FP_ENV;
    spoof=False launches stock (no APEX_FP_*) for a noise baseline."""
    for k in list(os.environ):
        if k.startswith("APEX_FP_"):
            del os.environ[k]
    if spoof:
        os.environ.update(FP_ENV)
    # HEADFUL on Xvfb -- the REAL production mode -- not --headless=new. This
    # matters for WebGL: headful routes ANGLE through Mesa llvmpipe
    # (MAX_TEXTURE_SIZE 16384, coherent with real Intel/Apple/AMD GPUs), while
    # --headless=new falls back to SwiftShader (8192, matches no real GPU).
    # Run this script under `xvfb-run`. Mirrors profile.chrome_launch_flags'
    # container WebGL setup so the self-check sees what production sees.
    # GL/WebGPU/stability flags come from the SINGLE production source
    # (profile._angle_backend_flags, honoring APEX_ANGLE_BACKEND) so the
    # self-check launches with byte-identical flags to what ships -- no
    # hand-rolled divergence (the old hand-rolled --use-angle=gl is what
    # crashed under Xvfb on a real GPU).
    from stealth_browser.profile import _angle_backend_flags
    args = [
        "--no-sandbox", "--disable-dev-shm-usage",
        *_angle_backend_flags(),
        "--no-first-run", "--no-default-browser-check",
    ]
    # sandbox=False: the --no-sandbox arg alone doesn't satisfy nodriver's own
    # launch guard when running as root (cloud/CI containers), so pass it
    # explicitly too -- otherwise start() raises "Failed to connect to browser".
    async def _start(launch_args):
        return await nodriver.start(browser_executable_path=bin_path,
                                    headless=False, sandbox=False,
                                    browser_args=launch_args)
    try:
        browser = await _start(args)
    except Exception as e:  # noqa: BLE001
        # Last-resort safety net: if even the production flags can't bring up a
        # GL context on this box, degrade to SwiftShader so the self-check runs.
        print(f"  (launch failed: {str(e)[:70]} -- retrying on swiftshader)")
        sw = [a for a in args if not a.startswith(("--use-gl", "--use-angle"))]
        sw += ["--use-gl=angle", "--use-angle=swiftshader",
               "--enable-unsafe-swiftshader"]
        browser = await _start(sw)
    try:
        tab = await browser.get(VERIFY_HTML.as_uri())
        await asyncio.sleep(1.5)
        raw = await tab.evaluate(PROBE_JS, await_promise=True,
                                 return_by_value=True)
    finally:
        browser.stop()
    return raw if isinstance(raw, dict) else _unwrap(raw)


async def run() -> int:
    bin_path = os.environ.get("APEX_CHROME_PATH")
    if not bin_path or not Path(bin_path).exists():
        print(f"ERROR: APEX_CHROME_PATH not set or missing: {bin_path!r}")
        return 2

    print(f"=== verify_patched_binary: {bin_path} ===")
    # Two passes: a stock baseline (no spoofing) then the spoofed run. The
    # noise patches (canvas/audio/measureText) can't be asserted to an exact
    # value -- they're per-seed random -- so we assert they DIFFER from stock,
    # the only version-independent proof the farbling actually fires. (This is
    # what would have caught the OfflineAudioContext audio gap, which produced
    # an identical hash spoof-on vs stock.)
    print("--- stock baseline pass (no APEX_FP_*) ---")
    stock = await _probe(bin_path, spoof=False)
    r = await _probe(bin_path, spoof=True)
    if not isinstance(r, dict) or not r:
        print(f"ERROR: probe returned no usable dict: {r!r}")
        return 2
    print("--- raw probe (spoofed) ---")
    print(json.dumps(r, indent=2)[:2000])

    results: list = []
    _check(results, r["platform"] == "MacIntel", "navigator.platform",
           r["platform"], "MacIntel")
    # UA string must carry the macOS token (persona is macOS) -- NOT the build's
    # real Linux token. This is the apex-ua-platform fix; without it the UA
    # string contradicts platform/userAgentData (a cross-check lie).
    _check(results, "Macintosh; Intel Mac OS X 10_15_7" in (r.get("userAgent") or "")
           and "Linux" not in (r.get("userAgent") or ""),
           "navigator.userAgent OS coherence", r.get("userAgent"), "Macintosh…")
    _check(results, r["hardwareConcurrency"] == 10,
           "navigator.hardwareConcurrency", r["hardwareConcurrency"], 10)
    _check(results, r["deviceMemory"] == 8, "navigator.deviceMemory",
           r["deviceMemory"], 8)
    _check(results, r["uaPlatform"] == "macOS",
           "userAgentData.platform", r["uaPlatform"], "macOS")
    # navigator.userAgentData.brands must include "Google Chrome" (a Chromium
    # build omits it -> rebrowser flags "not Google Chrome"). apex-brands patch.
    _check(results, "Google Chrome" in (r.get("uaBrands") or []),
           "userAgentData.brands includes Google Chrome", r.get("uaBrands"))
    _check(results, r["uachPlatform"] == "macOS",
           "UA-CH high-entropy platform (header coherence)",
           r["uachPlatform"], "macOS")
    _check(results, r["uachPlatformVersion"] == "14.6.0",
           "UA-CH platform version (header coherence)",
           r["uachPlatformVersion"], "14.6.0")
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
    # --- differential noise checks: farbled value must DIFFER from stock ---
    # The only version-independent proof the noise patches actually fire.
    # Guarded on a usable stock baseline so a flaky stock launch downgrades to
    # a skip rather than a false failure.
    if isinstance(stock, dict) and stock:
        _check(results, r["canvasTail"] != stock.get("canvasTail"),
               "canvas farbled vs stock", r["canvasTail"], "!= stock")
        _check(results, r["measureTextW"] != stock.get("measureTextW"),
               "measureText farbled vs stock",
               r["measureTextW"], stock.get("measureTextW"))
        if r["audioHash"] != "err" and stock.get("audioHash") not in (None, "err"):
            _check(results, r["audioHash"] != stock.get("audioHash"),
                   "OfflineAudioContext farbled vs stock (audio FP)",
                   r["audioHash"], stock.get("audioHash"))
        else:
            print(f"\n[AUDIO SKIP] no usable audio baseline "
                  f"(spoofed={r['audioHash']!r} stock={stock.get('audioHash')!r})")
        if r["blobHash"] != "err" and stock.get("blobHash") not in (None, "err"):
            _check(results, r["blobHash"] != stock.get("blobHash"),
                   "canvas.toBlob farbled vs stock",
                   r["blobHash"], stock.get("blobHash"))
        else:
            print(f"\n[toBlob SKIP] no usable blob baseline "
                  f"(spoofed={r['blobHash']!r} stock={stock.get('blobHash')!r})")
    else:
        print("\n[NOISE-DIFF SKIP] stock baseline pass unavailable — "
              "canvas/measureText/audio differential not measured")
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
        # WebGL NUMERIC coherence (informational, NOT a pass/fail surface).
        # The UNMASKED renderer string is spoofed natively, but the numeric
        # caps come from the real rendering backend. MAX_TEXTURE_SIZE driver-IDs
        # hardware at ~91% accuracy: real Apple/Intel/AMD report 16384, NVIDIA
        # 32768, but SwiftShader (a GPU-less host) reports 8192 -- which matches
        # NO real consumer GPU, so the string<->caps pair is incoherent there.
        # This is DEPLOYMENT-gated, not patchable: on a real-GPU host matching
        # the persona's gpu_class the caps are already correct; on SwiftShader
        # no caps-spoof fixes the render-OUTPUT pixel hash anyway. We surface it
        # so an incoherent (GPU-less) deployment is loud, not silent.
        rstr = r["webglRenderer"] or ""
        expected = (32768 if "NVIDIA" in rstr else 16384)  # all others 16384
        mts = r.get("maxTextureSize")
        if mts is not None and mts < expected:
            print(f"\n[WebGL CAPS INCOHERENT] renderer claims {rstr!r} but "
                  f"MAX_TEXTURE_SIZE={mts} (expected >= {expected}). This host "
                  f"renders via SwiftShader (8192) — string<->caps mismatch, a "
                  f"high-signal tell. FIX IS DEPLOYMENT: run on a GPU host whose "
                  f"class matches the persona. Not a binary defect.")
        else:
            print(f"\n[WebGL caps OK] MAX_TEXTURE_SIZE={mts} coherent with "
                  f"the claimed GPU (expected >= {expected}).")
    else:
        print(f"\n[WebGL SKIP] no GL context in this container "
              f"(err={r['webglErr']}) — patch fires inside getParameter; "
              f"untestable without GL, not a patch failure.")

    # WebGPU is now a HARD check: we launch with --enable-unsafe-webgpu +
    # --enable-features=Vulkan so Chrome's bundled SwiftShader Vulkan yields an
    # adapter even on a GPU-less box. An absent adapter means production would
    # ALSO lack WebGPU -- a coherence tell for macOS/Windows personas -- so it
    # must fail, not skip. When present, the apex-webgpu-adapterinfo override
    # MUST apply: vendor coherent with WebGL + isFallbackAdapter forced off.
    webgpu_ok = (r.get("webgpuErr") is None
                 and r.get("webgpuVendor") == FP_ENV["APEX_FP_WEBGPU_VENDOR"]
                 and r.get("webgpuIsFallback") is False)
    _check(results, webgpu_ok, "WebGPU adapter present + vendor + no-fallback",
           (r.get("webgpuVendor"), r.get("webgpuIsFallback"),
            r.get("webgpuErr")),
           (FP_ENV["APEX_FP_WEBGPU_VENDOR"], False, None))
    # apex-webgpu-limits: maxTextureDimension2D must be 16384 (real GPUs +
    # coherent with our WebGL MAX_TEXTURE_SIZE), not SwiftShader's 8192 floor.
    _check(results, r.get("webgpuMaxTex2D") == 16384,
           "WebGPU maxTextureDimension2D coherent (==WebGL 16384)",
           r.get("webgpuMaxTex2D"), 16384)
    # FP_ENV is an Apple persona -> ASTC is correct (kept). The non-Apple strip
    # (apex-webgpu-features) is checked at runtime by webgpu_limits_probe.
    _check(results, r.get("webgpuHasAstc") is True,
           "WebGPU ASTC present for Apple persona (family-correct)",
           r.get("webgpuHasAstc"), True)

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
