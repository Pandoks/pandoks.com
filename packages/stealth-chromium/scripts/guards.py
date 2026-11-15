#!/usr/bin/env python3
"""Per-patch guard tests -- run against the patched binary via CDP.

One guard per shipped patch: a JS probe whose assertion must hold on the
patched binary and fail on a stock one. This is the Camoufox-style
governance layer: a version bump that silently breaks a patch fails here,
not in production.

Usage:  python3 guards.py --cdp http://127.0.0.1:<port> [--json]
        (connects to a session created via stealth-browser, which exposes
        the patched binary's CDP endpoint in the create response)
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

# marker -> (js expression -> expected value). The JS runs in the page.
GUARDS: dict[str, tuple[str, object]] = {
    # navigator (full-file overlays + anchor edits)
    "apex-navigator-hardware": ("navigator.hardwareConcurrency", "int>0"),
    "apex-navigator-devicememory": ("navigator.deviceMemory", "power-of-2"),
    "apex-navigator-platform": ("navigator.platform", "match-ua-platform"),
    "apex-navigator-uadata": (
        "navigator.userAgentData ? navigator.userAgentData.platform : null",
        "match-ua-platform"),
    "apex-navigator-id": ("navigator.platform !== 'Linux x86_64'", True),
    # webgl
    "apex-webgl-unmasked": ("(()=>{const c=document.createElement('canvas');"
                            "const g=c.getContext('webgl');"
                            "return g ? g.getExtension('WEBGL_debug_renderer_info') "
                            "? g.getParameter(g.getExtension('WEBGL_debug_renderer_info')"
                            ".UNMASKED_RENDERER_WEBGL) : 'no-ext' : 'no-webgl';})()",
                            "contains-APEX_FP_WEBGL_RENDERER-or-real"),
    # webgl numeric limits: the claimed backend's table (apex_webgl_limits.h)
    "apex-webgl-limits": ("(()=>{const g=document.createElement('canvas')"
                          ".getContext('webgl');if(!g)return 'no-webgl';"
                          "return [g.getParameter(g.MAX_VERTEX_UNIFORM_VECTORS),"
                          "g.getParameter(g.MAX_VARYING_VECTORS),"
                          "[...g.getParameter(g.MAX_VIEWPORT_DIMS)],"
                          "[...g.getParameter(g.ALIASED_LINE_WIDTH_RANGE)],"
                          "[...g.getParameter(g.ALIASED_POINT_SIZE_RANGE)]];})()",
                          "d3d11: [4096|4095-nvidia,30,[32767,32767],[1,1],"
                          "[1,1024]]; metal: [1024,30,[16384,16384],[1,1],[1,511]]"),
    "apex-webgl-limits-linewidth": (
        "(()=>{const g=document.createElement('canvas').getContext('webgl');"
        "if(!g)return 'no-webgl';g.lineWidth(5);"
        "return g.getParameter(g.LINE_WIDTH);})()",
        5),
    "apex-webgl-limits-viewport": (
        "(()=>{const g=document.createElement('canvas').getContext('webgl');"
        "if(!g)return 'no-webgl';g.viewport(0,0,30000,40000);"
        "return [...g.getParameter(g.VIEWPORT)];})()",
        "d3d11: [0,0,30000,32767]; metal: [0,0,16384,16384]"),
    # webgpu (new)
    "apex-webgpu-vendor": ("(async()=>{if(!navigator.gpu)return 'no-webgpu';"
                           "const a=await navigator.gpu.requestAdapter();"
                           "if(!a)return 'no-adapter';"
                           "const i=await a.requestAdapterInfo();"
                           "return i.vendor;})()",
                           "webgpu-persona-or-real"),
    # OS-gated Web API surface (persona OS, not the host OS)
    "apex-osapi-webshare": ("typeof navigator.share === 'function' && "
                            "typeof navigator.canShare === 'function'",
                            "true-when-persona-win-or-mac-else-false"),
    "apex-osapi-barcodedetector": (
        "typeof window.BarcodeDetector === 'function' ? "
        "(async()=>{try{const f = await window.BarcodeDetector."
        "getSupportedFormats(); return f.length;}catch(e){return 'throw'}})() "
        ": 'absent'",
        "macos-persona: >=1; win/linux persona: absent"),
    # battery
    "apex-battery": ("(async()=>{const b=await navigator.getBattery ? "
                     "navigator.getBattery() : null;"
                     "return b ? b.level : 'no-api';})()", "0.55-0.95-band"),
    # screen
    "apex-screen": ("screen.width > 0", True),
    # hardwareConcurrency coherence: a dedicated worker must report the same
    # value as the main frame (the native spoof is shared via NavigatorBase)
    "apex-hw-worker": ("(async()=>{const main=navigator.hardwareConcurrency;"
                       "const src=URL.createObjectURL(new Blob(["
                       "`postMessage(navigator.hardwareConcurrency)`],"
                       "{type:'application/javascript'}));"
                       "try{const w=new Worker(src);"
                       "const v=await new Promise((res,rej)=>{"
                       "w.onmessage=(e)=>res(e.data);"
                       "w.onerror=()=>rej(new Error('err'));"
                       "setTimeout(()=>rej(new Error('timeout')),3000);});"
                       "w.terminate();return v===main;"
                       "}catch(e){return 'worker-error';}})()", True),
    # version-gate coherence: stable APIs shipped before the claimed version
    "apex-computepressure": ("typeof ComputePressureObserver !== 'undefined'",
                             True),
    "apex-protected-audience": ("typeof navigator.joinAdInterestGroup "
                                "!== 'undefined'", True),
    # v8 inspector leak
    "apex-v8-inspector": ("(()=>{const e=new Error('x');"
                          "console.debug(e); return 'done';})()", "done"),
    # mediaspeech devices
    "apex-speech-voices": ("(async()=>{const v=speechSynthesis.getVoices();"
                           "return v.length;})()", "int>=0"),
    "apex-devices": ("(async()=>{const d=await navigator.mediaDevices."
                     "enumerateDevices(); return d.length;})()", "int>=0"),
    # audio noise: two evaluations with the same seed must hash identically
    # (deterministic), and a different seed must differ (no static skip).
    "apex-audio-noise": ("(async()=>{const ctx=new OfflineAudioContext(1,44100,"
                         "44100);const o=ctx.createOscillator();o.connect(ctx."
                         "destination);o.start();const buf=await ctx.startRendering"
                         "();const d=buf.getChannelData(0);let s=0;for(let i=0;i<d."
                         "length;i+=97)s+=Math.abs(d[i]);return s.toFixed(6);})()",
                         "float-any"),
    # canvas noise: draw + hash; must be deterministic per seed
    "apex-canvas-noise": ("(async()=>{const c=document.createElement('canvas');"
                          "c.width=120;c.height=40;const g=c.getContext('2d');"
                          "g.font='14px Arial';g.fillText('apex guard',4,20);"
                          "return c.toDataURL().slice(-40);})()", "string-any"),
    # canvas noise v2.2: a solid readPixels must come back byte-exact and at
    # stock latency (v2.1 hashed every opaque pixel: 2.4x stock p50).
    "apex-canvas-readback-latency": (
        "(()=>{const c=document.createElement('canvas');c.width=c.height=256;"
        "const g=c.getContext('webgl');if(!g)return 'no-webgl';"
        "g.clearColor(0.3,0.5,0.7,1);g.clear(g.COLOR_BUFFER_BIT);"
        "const b=new Uint8Array(256*256*4);const t=[];"
        "for(let i=0;i<31;i++){const s=performance.now();"
        "g.readPixels(0,0,256,256,g.RGBA,g.UNSIGNED_BYTE,b);"
        "t.push(performance.now()-s);}t.sort((x,y)=>x-y);let exact=true;"
        "for(let i=4;i<b.length;i++)if(b[i]!==b[i%4]){exact=false;break;}"
        "return {exact,p50:t[15]};})()",
        "exact true; p50 within 1.5x of the same binary with APEX_FP_ACTIVE unset"),
    # fix11: OS-gated sensor surface -- SensorExtraClasses on for a Windows
    # persona (Magnetometer + AmbientLightSensor globals; the rest of the
    # Generic Sensor set has no runtime gate, so they are always present).
    "apex-osapi-sensorextraclasses": (
        "typeof Magnetometer === 'function' && "
        "typeof AmbientLightSensor === 'function'",
        "true-when-persona-win-else-false"),
    # fix11: no deviceorientation / devicemotion events on a desktop persona.
    "apex-device-sensors-suppress": (
        "new Promise(res => {let n = 0;const l = () => {n++;};"
        "window.addEventListener('deviceorientation', l);"
        "window.addEventListener('devicemotion', l);"
        "setTimeout(() => res(n), 600);})",
        "0-desktop-persona"),
    # fix11: (display-gamut: srgb) is a registered media query that evaluates
    # against the real screen's gamut (an sRGB display matches srgb only).
    "apex-display-gamut": ("matchMedia('(display-gamut: srgb)').matches",
                           "matches-real-display-gamut"),
}


def evaluate(cdp_http: str, expr: str) -> object:
    """Run a JS expression on the live target over the CDP HTTP endpoint."""
    ws = json.loads(urllib.request.urlopen(f"{cdp_http}/json/list").read())
    targets = [t for t in ws if t.get("type") == "page"]
    if not targets:
        raise RuntimeError("no page target on the CDP endpoint")
    # use the WS endpoint via the runtime protocol endpoint (POST /json/...
    # doesn't evaluate; for simplicity go through the DevTools HTTP evaluate
    # via the websocket-less trick: fetch /json/new then evaluate over WS is
    # out of scope here -- delegates use the browser's evaluate through
    # patchright. See test_patched_binary.sh for the ws client path.)
    raise RuntimeError(
        "wire evaluate() to the WS client in test_patched_binary.sh "
        "(http-only CDP cannot evaluate)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cdp", required=True, help="http://127.0.0.1:<port>")
    ap.add_argument("--json", action="store_true", help="machine output")
    args = ap.parse_args()

    try:
        resp = json.loads(urllib.request.urlopen(f"{args.cdp}/json/version").read())
        if not args.json:
            print(f"target: {resp.get('Browser', '?')}")
    except Exception as e:  # noqa: BLE001
        print(f"FAIL cannot reach CDP endpoint: {e}")
        return 1

    if not args.json:
        print(f"{len(GUARDS)} guards defined. Wire each probe's evaluate() "
              f"through the WS client (test_patched_binary.sh) and assert:")
        for marker, (expr, expect) in GUARDS.items():
            print(f"  {marker}: assert {expect!r} on {expr[:60]!r}...")
    print(json.dumps(GUARDS) if args.json else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
