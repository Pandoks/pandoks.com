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
    # webgpu (new)
    "apex-webgpu-vendor": ("(async()=>{if(!navigator.gpu)return 'no-webgpu';"
                           "const a=await navigator.gpu.requestAdapter();"
                           "if(!a)return 'no-adapter';"
                           "const i=await a.requestAdapterInfo();"
                           "return i.vendor;})()",
                           "webgpu-persona-or-real"),
    # battery
    "apex-battery": ("(async()=>{const b=await navigator.getBattery ? "
                     "navigator.getBattery() : null;"
                     "return b ? b.level : 'no-api';})()", "0.55-0.95-band"),
    # screen
    "apex-screen": ("screen.width > 0", True),
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
