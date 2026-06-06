#!/usr/bin/env python3
"""Bisect WHY WebGL is disabled in the production launch path but works in the
verifier. Same box, same binary; the only differences are the launch flags and
the nodriver.start() kwargs. Each mode launches ONE browser (one process, via
the wrapper) and probes whether WebGL actually initialises.

    APEX_CHROME_PATH=/path/to/chrome python webgl_ab.py <mode>

mode 0 = verifier-style args + sandbox=False        (known GOOD control)
mode 1 = full chrome_launch_flags + sandbox=False   (isolate the flag set)
mode 2 = full chrome_launch_flags + lang=, no sandbox kw (mimic StealthBrowser)
mode 3 = chrome_launch_flags minus --disable-features=...
mode 4 = chrome_launch_flags minus --enable-features=Vulkan
mode 5 = verifier args + --disable-features=IsolateOrigins,site-per-process,Translate
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import nodriver
from stealth_browser.profile import chrome_launch_flags, Identity
from stealth_browser.runner_nodriver import _unwrap

VERIFIER_ARGS = [
    "--no-sandbox", "--disable-dev-shm-usage",
    "--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist",
    "--enable-webgl", "--enable-unsafe-swiftshader",
    "--enable-unsafe-webgpu", "--enable-features=Vulkan",
    "--no-first-run", "--no-default-browser-check",
]
DISABLE_FEATURES = "--disable-features=IsolateOrigins,site-per-process,Translate"

PROBE = r"""(() => {
  const c = document.createElement('canvas');
  let gl = null, err = null;
  try { gl = c.getContext('webgl') || c.getContext('experimental-webgl'); }
  catch (e) { err = String(e); }
  if (!gl) return { ok: false, err: err || 'no context', renderer: null, maxTex: null };
  const u = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : null,
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    gl2: !!document.createElement('canvas').getContext('webgl2'),
  };
})()"""


def build(mode: int):
    """Return (browser_args, start_kwargs, label)."""
    os.environ["STEALTH_IN_DOCKER"] = "1"
    cflags = chrome_launch_flags(Identity(), headless=False)
    if mode == 0:
        return VERIFIER_ARGS, {"sandbox": False}, "verifier args (control)"
    if mode == 1:
        return cflags, {"sandbox": False}, "chrome_launch_flags + sandbox=False"
    if mode == 2:
        return (cflags, {"lang": "en-US"},
                "chrome_launch_flags + lang= (StealthBrowser-style)")
    if mode == 3:
        return ([f for f in cflags if f != DISABLE_FEATURES],
                {"sandbox": False}, "chrome_launch_flags MINUS --disable-features")
    if mode == 4:
        return ([f for f in cflags if f != "--enable-features=Vulkan"],
                {"sandbox": False}, "chrome_launch_flags MINUS Vulkan")
    if mode == 5:
        return (VERIFIER_ARGS + [DISABLE_FEATURES], {"sandbox": False},
                "verifier args + --disable-features (add suspect)")
    raise SystemExit(f"bad mode {mode}")


async def main() -> None:
    mode = int(sys.argv[1])
    args, kw, label = build(mode)
    page = Path(tempfile.gettempdir()) / "apex_webgl_ab.html"
    page.write_text("<!doctype html><html><body>x</body></html>")
    browser = await nodriver.start(
        browser_executable_path=os.environ["APEX_CHROME_PATH"],
        headless=False, browser_args=args, **kw)
    try:
        tab = await browser.get(page.as_uri())
        await asyncio.sleep(1.5)
        raw = await tab.evaluate(PROBE, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    finally:
        browser.stop()
    tag = "WEBGL-OK " if r.get("ok") else "WEBGL-DEAD"
    print(f"AB [{mode}] {tag} {label[:52]:52} "
          f"renderer={(r.get('renderer') or '')[:42]!r} "
          f"maxTex={r.get('maxTex')} gl2={r.get('gl2')} err={r.get('err')!r}")


if __name__ == "__main__":
    asyncio.run(main())
