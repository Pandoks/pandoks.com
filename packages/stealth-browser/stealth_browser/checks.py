"""Detection probes -- the same checks a real fingerprinter runs.

`PROBE_JS` is injected into a page and returns a dict of raw signals. `score()`
turns that into a pass/fail report. We deliberately re-implement the *cheap,
decisive* checks (webdriver flag, headless UA, CDP Runtime.enable leak, UA vs
platform coherence) so we get a fast verdict without depending on a remote
service -- then `creepjs.py` cross-checks against the real CreepJS page.
"""

from __future__ import annotations

# Runs in the page. Pure JS, no automation API. Returns a JSON-able object.
PROBE_JS = r"""
() => {
  const r = {};

  // --- 1. the classic automation flag ---
  r.webdriver = navigator.webdriver;                       // want: false

  // --- 2. headless markers in the UA ---
  const ua = navigator.userAgent;
  r.userAgent = ua;
  r.uaHasHeadless = /HeadlessChrome/i.test(ua);            // want: false

  // --- 3. UA <-> platform coherence (a top CreepJS "lie") ---
  r.platform = navigator.platform;
  const uaMac = /Macintosh|Mac OS X/.test(ua);
  const uaWin = /Windows/.test(ua);
  r.uaPlatformCoherent =
    (uaMac && navigator.platform === 'MacIntel') ||
    (uaWin && navigator.platform === 'Win32') ||
    (!uaMac && !uaWin);                                    // want: true

  // --- 4. real window chrome runtime object exists in real Chrome ---
  r.hasChromeObject = typeof window.chrome === 'object' && window.chrome !== null;
  r.hasChromeRuntime = !!(window.chrome && window.chrome.runtime !== undefined);

  // --- 5. permissions API must NOT contradict Notification state ---
  // headless Chrome historically returned 'denied' while Notification said
  // 'default' -- a famous tell.
  r.notificationPermission = (typeof Notification !== 'undefined')
    ? Notification.permission : 'no-Notification-API';

  // --- 6. plugins / mimeTypes: real desktop Chrome has the PDF plugin ---
  r.pluginsLength = navigator.plugins.length;              // want: > 0
  r.mimeTypesLength = navigator.mimeTypes.length;

  // --- 7. languages must be a non-empty array consistent with locale ---
  r.languages = navigator.languages;
  r.languagesOk = Array.isArray(navigator.languages)
    && navigator.languages.length > 0;

  // --- 8. WebGL must exist and report a real-ish GPU (not SwiftShader) ---
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      r.webglVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
      r.webglRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
      // WebGL must WORK and not report Chrome's internal "SwiftShader" (a
      // headless tell). 'llvmpipe' is Mesa's software renderer -- genuine on
      // the many real GPU-less Linux desktops/VMs, and CreepJS does not flag
      // it -- so it is accepted. A null/missing renderer is not.
      r.webglOk = !!r.webglRenderer
        && !/swiftshader/i.test(r.webglRenderer || '');
    } else {
      r.webglOk = false;
    }
  } catch (e) { r.webglOk = false; r.webglError = String(e); }

  // --- 9. canvas actually renders (toDataURL non-empty / non-blank) ---
  try {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 50;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#069';
    ctx.fillText('stealth-check \u{1F60A}', 2, 2);
    const data = c.toDataURL();
    r.canvasOk = data.length > 1000;                       // want: true
  } catch (e) { r.canvasOk = false; r.canvasError = String(e); }

  // --- 10. CDP Runtime.enable leak (the decisive 2026 signal) ---
  // When an automation client enables the CDP 'Runtime' domain, logging an
  // Error serializes it across the CDP socket, which triggers a getter on
  // .stack. If the getter fires, CDP is observable from page JS.
  let cdpLeak = false;
  try {
    const e = new Error();
    Object.defineProperty(e, 'stack', {
      configurable: true,
      get() { cdpLeak = true; return ''; },
    });
    // eslint-disable-next-line no-console
    console.debug(e);
  } catch (_) { /* ignore */ }
  r.cdpRuntimeLeak = cdpLeak;                              // want: false

  // --- 11. hardwareConcurrency / deviceMemory present & plausible ---
  r.hardwareConcurrency = navigator.hardwareConcurrency;
  r.deviceMemory = navigator.deviceMemory;
  r.hardwareOk = navigator.hardwareConcurrency >= 2;

  // --- 12. outerWidth/innerWidth: headless often has outer == 0 ---
  r.outerWidth = window.outerWidth;
  r.innerWidth = window.innerWidth;
  r.windowDimsOk = window.outerWidth > 0 && window.outerHeight > 0;

  return r;
}
"""


# Each check: (key, human label, predicate on the probe dict).
_CHECKS = [
    ("webdriver", "navigator.webdriver is false",
     lambda p: p.get("webdriver") in (False, None)),
    ("uaHasHeadless", "UA has no 'HeadlessChrome'",
     lambda p: p.get("uaHasHeadless") is False),
    ("uaPlatformCoherent", "UA matches navigator.platform",
     lambda p: p.get("uaPlatformCoherent") is True),
    ("hasChromeObject", "window.chrome object present",
     lambda p: p.get("hasChromeObject") is True),
    ("pluginsLength", "navigator.plugins non-empty",
     lambda p: (p.get("pluginsLength") or 0) > 0),
    ("languagesOk", "navigator.languages non-empty array",
     lambda p: p.get("languagesOk") is True),
    ("webglOk", "WebGL works, renderer not SwiftShader",
     lambda p: p.get("webglOk") is True),
    ("canvasOk", "canvas renders (toDataURL non-blank)",
     lambda p: p.get("canvasOk") is True),
    ("cdpRuntimeLeak", "no CDP Runtime.enable leak",
     lambda p: p.get("cdpRuntimeLeak") is False),
    ("hardwareOk", "hardwareConcurrency plausible",
     lambda p: p.get("hardwareOk") is True),
    ("windowDimsOk", "window outer dimensions > 0",
     lambda p: p.get("windowDimsOk") is True),
]


def score(probe: dict) -> dict:
    """Turn a raw probe dict into {passed, total, failures, results}."""
    results = []
    failures = []
    for key, label, predicate in _CHECKS:
        try:
            ok = bool(predicate(probe))
        except Exception:  # noqa: BLE001 - a throwing predicate is a failure
            ok = False
        results.append({"key": key, "label": label, "ok": ok,
                        "value": probe.get(key)})
        if not ok:
            failures.append(label)
    passed = sum(1 for r in results if r["ok"])
    return {
        "passed": passed,
        "total": len(_CHECKS),
        "failures": failures,
        "results": results,
    }


def format_report(name: str, scored: dict, extra: dict | None = None) -> str:
    lines = [f"\n=== {name} ===",
             f"  local checks: {scored['passed']}/{scored['total']}"]
    for r in scored["results"]:
        mark = "PASS" if r["ok"] else "FAIL"
        val = r["value"]
        val_s = "" if val is None else f"  ({val!r})"
        lines.append(f"  [{mark}] {r['label']}{val_s if not r['ok'] else ''}")
    if extra:
        for k, v in extra.items():
            lines.append(f"  {k}: {v}")
    return "\n".join(lines)
