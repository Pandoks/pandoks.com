#!/usr/bin/env python3
"""Temporal-stability audit: does ANY fingerprint identity surface drift
between requests in the SAME session?

Loads a target page twice in one session (plus a same-page double collection
and a cross-origin collection) and diffs the fingerprint surfaces that must be
stable for a session identity: canvas, audio, WebGL, WebGPU, navigator, screen,
battery, timezone/Intl, fonts, voices, permissions. Values that legitimately
vary (timings, connection rtt, mediaDevices per-origin ids) are excluded.

Anything that differs between two collections in one session is printed with
both values and exits non-zero.

Verified findings (2026-11): no per-request drift on either backend. The
session seed is per-SESSION (`NodriverCore.__init__`: one
`random.getrandbits(32)`, exported once as APEX_FP_* before launch and read
from the process env for the browser's whole lifetime), so canvas/audio noise
is stable within a session. Cross-session stability differs by design:
canvas farbling is persona-keyed (APEX_FP_CANVAS_KEY, derived from the
persona label -- stable across sessions), audio intentionally keeps stock
output (the +/-1e-7 offline-context edit was removed after it moved the hash
into a rare cluster). NOTE: a patched binary built before commit 7c37167b
(canvas farbling v2) keys canvas on the per-session seed instead, so its
canvas hash differs between sessions for the same persona -- rebuild the
binary to get persona-stable canvas.

Usage:
  python scripts/temporal_audit.py --base http://127.0.0.1:8089 \
    --target http://host.docker.internal:8099/fp-page
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

# Surfaces that MUST be byte-stable within one session. Nested dicts are
# compared recursively; excluded keys are dropped before the diff.
UNSTABLE_PREFIXES = (
    "connection.rtt", "connection.downlink", "connection.residual",  # timing
    "media.devices.deviceId",  # per-origin device ids, by spec
    "performance.",  # performance timelines
)
UNSTABLE_KEYS = {
    "navigator.maxTouchPoints",  # platform fact, stable, but include anyway
}


def api(base: str, method: str, path: str, body: dict | None = None,
        timeout: float = 180) -> tuple[int, object]:
    req = urllib.request.Request(base + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw[:1] in (b"{", b"[") else raw
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


# The fingerprint collector. Async so WebGPU/battery/UA high-entropy promises
# settle. Returns a flat-ish dict of identity surfaces.
COLLECT_JS = r"""
async () => {
  const r = {};
  const h = s => {  // fnv-1a hex
    let hsh = 0x811c9dc5;
    const u = new TextEncoder().encode(String(s));
    for (const b of u) { hsh ^= b; hsh = (hsh * 0x01000193) >>> 0; }
    return ('0000000' + hsh.toString(16)).slice(-8);
  };
  // --- navigator ---
  r.navigator = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: JSON.stringify(navigator.languages),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    cookieEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    webdriver: navigator.webdriver,
    pluginsHash: h(Array.from(navigator.plugins).map(p => p.name).join('|')),
    mimeTypesHash: h(Array.from(navigator.mimeTypes).map(m => m.type).join('|')),
    bluetoothAvailable: !!(navigator.bluetooth && navigator.bluetooth.getAvailability),
  };
  if (navigator.userAgentData) {
    const he = await navigator.userAgentData.getHighEntropyValues([
      'architecture', 'platformVersion', 'model', 'bitness', 'wow64',
      'fullVersionList', 'uaFullVersion']);
    r.navigator.userAgentData = {
      platform: navigator.userAgentData.platform,
      mobile: navigator.userAgentData.mobile,
      brands: JSON.stringify(navigator.userAgentData.brands),
      architecture: he.architecture, platformVersion: he.platformVersion,
      model: he.model, bitness: he.bitness, wow64: he.wow64,
      fullVersionList: JSON.stringify(he.fullVersionList),
      uaFullVersion: he.uaFullVersion,
    };
  }
  // --- screen / window ---
  r.screen = {
    width: screen.width, height: screen.height,
    availWidth: screen.availWidth, availHeight: screen.availHeight,
    colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    devicePixelRatio: devicePixelRatio,
    outerWidth: outerWidth, outerHeight: outerHeight,
    innerWidth: innerWidth, innerHeight: innerHeight,
    screenX: screenX, screenY: screenY,
  };
  // --- canvas (content-keyed farbling -> must be identical every call) ---
  const cv = document.createElement('canvas');
  cv.width = 300; cv.height = 100;
  const cx = cv.getContext('2d');
  cx.font = '24px Arial';
  cx.fillText('apex-temporal-audit', 5, 50);
  cx.fillStyle = 'rgb(120,20,220)';
  cx.fillRect(0, 70, 300, 30);
  r.canvas = {
    toDataURLHash1: h(cv.toDataURL()),
    toDataURLHash2: h(cv.toDataURL()),  // re-request -> intra-request stable
    getImageDataHash: h(JSON.stringify(Array.from(
      cx.getImageData(0, 0, 20, 10).data.slice(0, 400)))),
  };
  // --- webgl ---
  try {
    const c2 = document.createElement('canvas');
    const gl = c2.getContext('webgl2') || c2.getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const params = {};
      for (const p of ['MAX_TEXTURE_SIZE', 'MAX_TEXTURE_IMAGE_UNITS',
                       'MAX_VIEWPORT_DIMS', 'MAX_VERTEX_UNIFORM_VECTORS',
                       'MAX_RENDERBUFFER_SIZE', 'ALIASED_POINT_SIZE_RANGE']) {
        params[p] = JSON.stringify(gl.getParameter(gl[p]));
      }
      const prec = gl.getShaderPrecisionFormat(
        gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      r.webgl = {
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        params: params,
        fragmentHighFloatPrecision: prec ? prec.precision : null,
        fragmentHighFloatRange: prec ?
          JSON.stringify([prec.rangeMin, prec.rangeMax]) : null,
        extensionsCount: (gl.getSupportedExtensions() || []).length,
        contextTypes: (c2.getContext('webgl2') ? 'webgl2' : 'webgl') +
          ':' + (c2.getContext('webgl') ? 'webgl' : 'none'),
      };
    } else { r.webgl = 'no-context'; }
  } catch (e) { r.webgl = 'error:' + e; }
  // --- webgpu ---
  try {
    if (navigator.gpu && navigator.gpu.requestAdapter) {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) {
        const info = {};
        if (ad.info) {
          for (const k of ['vendor', 'architecture', 'device', 'description',
                           'driver', 'type']) {
            info[k] = ad.info[k] ?? null;
          }
        }
        const lim = {};
        for (const k of ['maxTextureDimension2D', 'maxBindGroups',
                         'maxComputeInvocationsPerWorkgroup',
                         'maxBufferSize', 'maxComputeWorkgroupStorageSize']) {
          lim[k] = ad.limits[k] ?? null;
        }
        r.webgpu = { adapterInfo: info, limits: lim,
                     features: JSON.stringify(Array.from(ad.features).sort()) };
      } else { r.webgpu = 'no-adapter'; }
    } else { r.webgpu = 'no-gpu-api'; }
  } catch (e) { r.webgpu = 'error:' + e; }
  // --- audio (OfflineAudioContext render, deterministic per seed) ---
  // Canonical audio-fingerprint shape: oscillator -> compressor so the
  // rendered samples carry a non-trivially-computable signature.
  try {
    const ac = new OfflineAudioContext(1, 44100, 44100);
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 500;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -50;
    comp.knee.value = 40;
    comp.ratio.value = 12;
    comp.attack.value = 0;
    comp.release.value = 0.25;
    osc.connect(comp);
    comp.connect(ac.destination);
    osc.start(0);
    const buf = await ac.startRendering();
    const data = buf.getChannelData(0);
    const bytes = new Float32Array(4410);
    for (let i = 0; i < 4410; i++) bytes[i] = data[i];
    r.audio = { renderHash: h(JSON.stringify(Array.from(bytes))) };
  } catch (e) { r.audio = 'error:' + e; }
  // --- battery ---
  try {
    const b = await navigator.getBattery();
    r.battery = { level: b.level, charging: b.charging };
  } catch (e) { r.battery = 'error:' + e; }
  // --- timezone / locale / Intl ---
  r.intl = {
    tzOffset: new Date().getTimezoneOffset(),
    resolvedTimezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    resolvedLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
    dateEpoch0Local: new Intl.DateTimeFormat().format(new Date(0)),
    numberFormat: new Intl.NumberFormat().format(1234567.89),
    collatorLocale: new Intl.Collator().resolvedOptions().locale,
    dateToStringEpoch0: new Date(0).toString(),
    currencyFormat: new Intl.NumberFormat(undefined,
      { style: 'currency', currency: 'USD' }).format(1),
  };
  // --- fonts (canvas measureText widths) ---
  const fc = document.createElement('canvas').getContext('2d');
  const widths = {};
  for (const f of ['Arial', 'Helvetica', 'Georgia', 'Times New Roman',
                   'Courier New', 'Comic Sans MS', 'Verdana']) {
    fc.font = `72px '${f}'`;
    widths[f] = fc.measureText('mmmwmwwmwm').width;
  }
  r.fonts = { widths: JSON.stringify(widths) };
  // --- voices (prime first: Chrome loads the list async) ---
  try {
    speechSynthesis.getVoices();
    await new Promise(res => setTimeout(res, 400));
    const v = speechSynthesis.getVoices();
    r.voices = { count: v.length,
                 namesHash: v.length ? h(v.map(x => x.name).join('|')) : 'none' };
  } catch (e) { r.voices = 'error:' + e; }
  // --- media devices (kinds + labels; ids are per-origin by spec) ---
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    r.media = { kindsHash: h(devs.map(d => d.kind + ':' + d.label).join('|')) };
  } catch (e) { r.media = 'error:' + e; }
  // --- permissions ---
  try {
    const names = ['geolocation', 'notifications', 'camera', 'microphone',
                   'midi', 'clipboard-read'];
    const states = {};
    for (const n of names) {
      states[n] = (await navigator.permissions.query({ name: n })).state;
    }
    r.permissions = states;
  } catch (e) { r.permissions = 'error:' + e; }
  // --- connection (only the type-ish fields, not timing) ---
  try {
    const c = navigator.connection;
    r.connection = { effectiveType: c ? c.effectiveType : null,
                     type: c ? c.type : null };
  } catch (e) { r.connection = 'error:' + e; }
  // --- chrome object ---
  r.chromeKeys = h(typeof window.chrome === 'object' && window.chrome
    ? Object.keys(window.chrome).sort().join('|') : 'none');
  return r;
}
"""


def flatten(d: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}" if not prefix else f"{prefix}.{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def is_unstable(key: str) -> bool:
    return (key in UNSTABLE_KEYS
            or any(key.startswith(p) for p in UNSTABLE_PREFIXES))


def diff(a: dict, b: dict) -> dict[str, tuple]:
    out = {}
    for k in sorted(set(a) | set(b)):
        if is_unstable(k):
            continue
        if a.get(k) != b.get(k):
            out[k] = (a.get(k), b.get(k))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8089")
    ap.add_argument("--target", default="http://host.docker.internal:8099/fp-page")
    ap.add_argument("--profile", default=None)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    body = {"profile": args.profile} if args.profile else {}
    status, created = api(base, "POST", "/sessions", body=body)
    if status not in (200, 201) or not isinstance(created, dict):
        print(f"session create failed: {status} {created}", file=sys.stderr)
        return 2
    sid = created["id"]
    profile = created.get("profile", {})
    print(f"session {sid}: profile={json.dumps(profile)}")
    failures: list[str] = []
    try:
        collections: dict[str, dict] = {}

        def collect(tag: str) -> dict:
            # /eval takes an expression; the collector is an arrow function,
            # so it must be invoked (checks.PROBE_JS has the same shape).
            expr = f"({COLLECT_JS.strip()})()"
            status, ev = api(base, "POST", f"/sessions/{sid}/eval",
                             body={"expression": expr})
            if status != 200 or not isinstance(ev, dict):
                raise RuntimeError(f"eval failed: {status} {ev}")
            res = ev.get("result")
            probe = json.loads(res) if isinstance(res, str) else res
            if not isinstance(probe, dict):
                raise RuntimeError(f"probe not a dict: {probe!r}")
            collections[tag] = flatten(probe)
            return collections[tag]

        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": args.target})
        if status != 200:
            raise RuntimeError(f"navigate failed: {status}")
        time.sleep(2)
        c1 = collect("load1")
        c2 = collect("load1-repeat")          # same page, second collection
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": args.target})
        if status != 200:
            raise RuntimeError("re-navigate failed")
        time.sleep(2)
        c3 = collect("load2")                 # second full page load
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": "about:blank"})
        status, _ = api(base, "POST", f"/sessions/{sid}/navigate",
                        body={"url": args.target})
        if status != 200:
            raise RuntimeError("third navigate failed")
        time.sleep(2)
        c4 = collect("load3")                 # after blank round-trip

        for a_tag, b_tag in (("load1", "load1-repeat"),
                             ("load1", "load2"),
                             ("load2", "load3")):
            d = diff(collections[a_tag], collections[b_tag])
            if d:
                for k, (av, bv) in d.items():
                    failures.append(f"{a_tag} vs {b_tag}: {k}: {av!r} != {bv!r}")
        print(json.dumps({k: v for k, v in c1.items()}, indent=2)[:4000])
    finally:
        api(base, "DELETE", f"/sessions/{sid}")

    if failures:
        print(f"\nTEMPORAL DRIFT: {len(failures)} differing identity value(s)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nTEMPORAL STABILITY: clean -- no identity surface drifted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
