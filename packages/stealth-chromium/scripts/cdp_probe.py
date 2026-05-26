#!/usr/bin/env python3
"""Raw-CDP probe of the apex-chromium patched binary -- no driver in the way.

Launches the patched binary with APEX_FP_* env, connects over the DevTools
WebSocket, and reads every patched fingerprint surface plus toString integrity.
This isolates the C++ patches from any automation framework.

Usage: uv run python cdp_probe.py /path/to/Chromium
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

from websocket import create_connection

BIN = sys.argv[1] if len(sys.argv) > 1 else (
    "/Volumes/X9Pro/apex-chromium-build/chromium/src/out/apex/"
    "Chromium.app/Contents/MacOS/Chromium")
PORT = 9580

# A Windows persona -- deliberately unlike the macOS host, so any value that
# comes back matching the persona proves the C++ patch fired.
FP = {
    "APEX_FP_ACTIVE": "1",
    "APEX_FP_SEED": "13371337",
    "APEX_FP_PLATFORM": "Win32",
    "APEX_FP_UA_PLATFORM": "Windows",
    "APEX_FP_HW_CONCURRENCY": "8",
    "APEX_FP_DEVICE_MEMORY": "4",
    "APEX_FP_WEBGL_VENDOR": "Google Inc. (Intel)",
    "APEX_FP_WEBGL_RENDERER": "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics "
                              "Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "APEX_FP_SCREEN_W": "1366",
    "APEX_FP_SCREEN_H": "768",
    "APEX_FP_SCREEN_AVAIL_W": "1366",
    "APEX_FP_SCREEN_AVAIL_H": "728",
    "APEX_FP_COLOR_DEPTH": "24",
    "APEX_FP_BATTERY_LEVEL": "0.73",
    "APEX_FP_BATTERY_CHARGING": "0",
}


def main() -> int:
    profile = tempfile.mkdtemp()
    env = {**os.environ, **FP}
    proc = subprocess.Popen(
        [BIN, "--headless=new", "--no-sandbox", f"--user-data-dir={profile}",
         f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
         "https://example.com/"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    try:
        ws_url = None
        # First-launch on macOS can be slow (Gatekeeper + signature verify),
        # especially on an external SSD -- allow up to 60s for /json to answer.
        for _ in range(120):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen(
                        f"http://localhost:{PORT}/json", timeout=2) as r:
                    targets = json.load(r)
                pages = [t for t in targets if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                continue
        if not ws_url:
            print("FAIL: could not get DevTools WebSocket URL")
            return 1

        # Chrome was launched with the HTTPS URL as the startup arg, so the
        # page is already a secure context; give it a moment to finish loading.
        time.sleep(6)
        ws = create_connection(ws_url, timeout=20)
        msg_id = [0]

        def ev(expr):
            msg_id[0] += 1
            ws.send(json.dumps({
                "id": msg_id[0], "method": "Runtime.evaluate",
                "params": {"expression": expr, "returnByValue": True}}))
            while True:
                m = json.loads(ws.recv())
                if m.get("id") == msg_id[0]:
                    res = m.get("result", {}).get("result", {})
                    return res.get("value")

        checks = [
            ("navigator.platform", "navigator.platform", "Win32"),
            ("navigator.hardwareConcurrency",
             "navigator.hardwareConcurrency", 8),
            ("navigator.deviceMemory", "navigator.deviceMemory", 4),
            ("userAgentData.platform",
             "navigator.userAgentData && navigator.userAgentData.platform",
             "Windows"),
            ("screen.width", "screen.width", 1366),
            ("screen.height", "screen.height", 768),
            ("screen.colorDepth", "screen.colorDepth", 24),
            ("WebGL UNMASKED_RENDERER",
             "(function(){var g=document.createElement('canvas')"
             ".getContext('webgl');var d=g.getExtension("
             "'WEBGL_debug_renderer_info');"
             "return g.getParameter(d.UNMASKED_RENDERER_WEBGL)})()",
             "Iris"),
        ]
        print(f"=== apex-chromium C++ patch verification (raw CDP) ===")
        print(f" binary: {BIN}\n")
        passed = failed = 0
        for label, expr, expect in checks:
            got = ev(expr)
            ok = (str(expect) in str(got)) if isinstance(expect, str) \
                else (got == expect)
            mark = "PASS" if ok else "FAIL"
            if ok:
                passed += 1
            else:
                failed += 1
            print(f"  [{mark}] {label:32} = {got!r}  (want ~{expect!r})")

        # toString integrity -- the decisive no-JS-tampering check
        ts_checks = [
            ("HTMLCanvasElement.toDataURL",
             "HTMLCanvasElement.prototype.toDataURL.toString()"),
            ("WebGLRenderingContext.getParameter",
             "WebGLRenderingContext.prototype.getParameter.toString()"),
            ("AudioBuffer.getChannelData",
             "AudioBuffer.prototype.getChannelData.toString()"),
        ]
        print()
        for label, expr in ts_checks:
            s = ev(expr)
            native = "[native code]" in str(s)
            mark = "PASS" if native else "FAIL"
            if native:
                passed += 1
            else:
                failed += 1
            print(f"  [{mark}] toString {label:28} = {s!r}")

        # CDP inspector leak probe (the 2026 vector)
        cdp_leak = ev(
            "(function(){var d=false;try{var p=Object.create("
            "new Proxy({},{ownKeys(){d=true;return[]},"
            "getOwnPropertyDescriptor(){return undefined}}));"
            "console.groupEnd(p)}catch(e){}return d})()")
        mark = "PASS" if not cdp_leak else "FAIL"
        if not cdp_leak:
            passed += 1
        else:
            failed += 1
        print(f"  [{mark}] CDP inspector-preview leak       = "
              f"{'no leak' if not cdp_leak else 'LEAKED'}")

        ws.close()
        print(f"\n=== {passed} passed, {failed} failed ===")
        return 0 if failed == 0 else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        import shutil
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
