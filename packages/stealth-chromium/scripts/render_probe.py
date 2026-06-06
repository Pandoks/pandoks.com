#!/usr/bin/env python3
"""Render deterministic canvas2d + WebGL scenes and hash the raw pixel output.

Used to answer: is our llvmpipe (software) render output distinguishable from a
real GPU's, and does our farbling decorrelate it? Run the SAME scene on a real
GPU and on llvmpipe (same box, via render_gpu.sh) with farbling OFF to measure
the raw hardware-vs-software delta; run with farbling ON to confirm the apex
noise moves the hash off the raw baseline (so no fixed software signature
leaks).

    APEX_CHROME_PATH=/path/to/chrome python render_probe.py <label> [farble0|farble1]

The scene is fixed (deterministic geometry + shader + text) so any hash
difference is attributable to the renderer, not the input.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

import nodriver
from stealth_browser.runner_nodriver import _unwrap

# A deterministic canvas2d + WebGL scene. WebGL: a single gradient-shaded
# triangle (sub-pixel coverage + interpolation expose rasteriser differences);
# readback as raw RGBA bytes. canvas2d: text + arc + gradient (the classic
# fingerprint surface). Returns hex digests of the raw bytes.
SCENE = r"""(() => {
  // --- canvas2d ---
  const c = document.createElement('canvas'); c.width = 280; c.height = 70;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0,0,280,0);
  g.addColorStop(0,'#f33'); g.addColorStop(0.5,'#3f3'); g.addColorStop(1,'#33f');
  x.fillStyle = g; x.fillRect(0,0,280,70);
  x.fillStyle = '#000'; x.font = '18px Arial'; x.textBaseline = 'top';
  x.fillText('apex-render \u{1F600} éçñ', 4, 4);
  x.strokeStyle = 'rgba(0,0,0,0.6)'; x.beginPath(); x.arc(140,45,22,0,7); x.stroke();
  const c2dData = x.getImageData(0,0,280,70).data;

  // --- webgl ---
  const wc = document.createElement('canvas'); wc.width = 256; wc.height = 256;
  const gl = wc.getContext('webgl', {preserveDrawingBuffer:true});
  let glRenderer = '', glPixHex = null;
  if (gl) {
    const u = gl.getExtension('WEBGL_debug_renderer_info');
    glRenderer = u ? gl.getParameter(u.UNMASKED_RENDERER_WEBGL) : '';
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p; varying vec2 v; void main(){ v=p; gl_Position=vec4(p,0.0,1.0); }');
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, 'precision highp float; varying vec2 v; void main(){ gl_FragColor=vec4(abs(v.x), abs(v.y), 0.5+0.5*sin(v.x*12.0), 1.0); }');
    gl.compileShader(fs);
    const pr = gl.createProgram(); gl.attachShader(pr,vs); gl.attachShader(pr,fs);
    gl.linkProgram(pr); gl.useProgram(pr);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8,-0.8, 0.8,-0.7, 0.1,0.85]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr,'p'); gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    gl.clearColor(0.1,0.1,0.1,1.0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES,0,3);
    const px = new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,px);
    glPixHex = Array.from(px);
  }
  return {
    c2d: Array.from(c2dData),
    glRenderer, gl: glPixHex,
  };
})()"""


def _sha(arr):
    if not arr:
        return None
    return hashlib.sha256(bytes(int(b) & 0xFF for b in arr)).hexdigest()[:32]


async def main() -> None:
    label = sys.argv[1] if len(sys.argv) > 1 else "run"
    farble = (len(sys.argv) > 2 and sys.argv[2] == "farble1")
    seed = sys.argv[3] if len(sys.argv) > 3 else "4242"
    backend = os.environ.get("APEX_ANGLE_BACKEND", "gl")  # gl | swiftshader
    for k in list(os.environ):
        if k.startswith("APEX_FP_"):
            del os.environ[k]
    if farble:
        # a fixed Windows/NVIDIA-ish identity so farbling is active + seeded
        os.environ.update({
            "APEX_FP_ACTIVE": "1", "APEX_FP_SEED": seed,
            "APEX_FP_PLATFORM": "Win32", "APEX_FP_UA_PLATFORM": "Windows",
            "APEX_FP_WEBGL_VENDOR": "Google Inc. (NVIDIA)",
            "APEX_FP_WEBGL_RENDERER": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)",
        })
    args = [
        "--no-sandbox", "--disable-dev-shm-usage",
        "--use-gl=angle", f"--use-angle={backend}", "--ignore-gpu-blocklist",
        "--enable-webgl", "--enable-unsafe-swiftshader",
        "--no-first-run", "--no-default-browser-check",
    ]
    page = Path(tempfile.gettempdir()) / "apex_render.html"
    page.write_text("<!doctype html><html><body>x</body></html>")
    browser = await nodriver.start(
        browser_executable_path=os.environ["APEX_CHROME_PATH"],
        headless=False, sandbox=False, browser_args=args)
    try:
        tab = await browser.get(page.as_uri())
        await asyncio.sleep(1.5)
        raw = await tab.evaluate(SCENE, return_by_value=True)
        r = raw if isinstance(raw, dict) else _unwrap(raw)
    finally:
        browser.stop()
    out = {
        "label": label, "farble": farble, "backend": backend, "seed": seed,
        "glRenderer": r.get("glRenderer"),
        "canvas2dHash": _sha(r.get("c2d")),
        "webglHash": _sha(r.get("gl")),
    }
    print("RENDER_RESULT " + json.dumps(out))


if __name__ == "__main__":
    asyncio.run(main())
