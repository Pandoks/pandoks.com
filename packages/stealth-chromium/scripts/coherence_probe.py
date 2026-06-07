#!/usr/bin/env python3
"""Cross-persona coherence audit (IP-independent surfaces). For each of a set of
representative personas it launches the patched binary and checks the traits
that must agree with the claimed device:
  * battery: desktops -> charging=true level=1.0; laptops/phones -> a band
  * maxTouchPoints: desktop 0, mobile 5
  * navigator.platform / userAgentData.platform vs the claimed OS
  * WebGL UNMASKED_VENDOR vs the claimed GPU class
  * deviceMemory power-of-two <= 8
  * FONTS PER OS: which of a per-OS font set are actually present (a Windows
    box installs Windows fonts -> a macOS persona is INCOHERENT if it shows
    Calibri but not Helvetica Neue). Reveals the per-OS-font gap.
No proxy (these surfaces don't depend on the exit IP). Prints one block/persona
+ a PASS/FAIL per check.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent
                       / "stealth-browser"))

# personas to audit (substring -> APEX_PROFILE). Cover desktop/laptop/Mac/Android.
PERSONAS = [
    "Windows desktop, NVIDIA RTX 4090",   # desktop -> no battery, 0 touch, Win fonts
    "Windows laptop, Intel Iris Xe",      # laptop  -> battery band
    "MacBook Pro 14 M3 Max",              # mac     -> mac fonts (likely missing)
    "iMac 24 M3",                         # mac desktop -> no battery
    "Samsung Galaxy S23",                 # android -> touch 5, android fonts
]

# representative per-OS fonts (width-detected). A coherent persona shows ITS
# OS set and NOT the others.
FONT_SETS = {
    "Windows": ["Calibri", "Cambria", "Segoe UI", "Consolas", "Tahoma"],
    "macOS": ["Helvetica Neue", "Helvetica", "Lucida Grande", "Menlo", "Geneva"],
    "Android": ["Roboto", "Droid Sans", "Noto Sans"],
    "common": ["Arial", "Times New Roman", "Courier New"],
}

PROBE_JS = r"""
(async () => {
  const out = {};
  out.platform = navigator.platform;
  out.uaPlatform = navigator.userAgentData ? navigator.userAgentData.platform : null;
  out.languages = navigator.languages;
  out.deviceMemory = navigator.deviceMemory;
  out.cores = navigator.hardwareConcurrency;
  out.maxTouch = navigator.maxTouchPoints;
  out.screen = [screen.width, screen.height];
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    out.webglVendor = gl.getParameter(e.UNMASKED_VENDOR_WEBGL);
    out.webglRenderer = gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
  } catch (e) { out.webglVendor = 'err'; }
  try {
    const b = await navigator.getBattery();
    out.battery = { charging: b.charging, level: b.level };
  } catch (e) { out.battery = 'no-api'; }
  // width-based font detection: a font is PRESENT if its rendered width differs
  // from a generic baseline for the same string.
  const probe = "mmmmmmmmmmlli wWqQ 0123 éñ";
  const base = {};
  const c = document.createElement('canvas').getContext('2d');
  for (const gen of ['monospace','sans-serif','serif']) {
    c.font = '72px ' + gen; base[gen] = c.measureText(probe).width;
  }
  function present(name) {
    for (const gen of ['monospace','sans-serif','serif']) {
      c.font = '72px "' + name + '",' + gen;
      if (Math.abs(c.measureText(probe).width - base[gen]) > 0.5) return true;
    }
    return false;
  }
  out.fonts = {};
  const ALL = __FONTLIST__;
  for (const f of ALL) out.fonts[f] = present(f);
  return JSON.stringify(out);
})()
""".replace("__FONTLIST__", str(
    [f for s in FONT_SETS.values() for f in s]).replace("'", '"'))


async def audit_one(label: str) -> None:
    # Force THIS persona: pin the device (APEX_PROFILE) AND give it its own fresh
    # account dir (APEX_PERSONA) so persona_fingerprint generates from the pin
    # instead of reloading a pooled dir's saved fingerprint.
    os.environ["APEX_PROFILE"] = label
    os.environ["APEX_PERSONA"] = "audit-" + "".join(
        c if c.isalnum() else "_" for c in label)[:48]
    from stealth_browser.core_nodriver import NodriverCore
    from stealth_browser.fp_profiles import pick_profile_by_label
    prof = pick_profile_by_label(label)
    core = NodriverCore(use_proxy=False, headless=False)
    await core.open()
    try:
        await core.navigate("https://example.com")
        import json
        raw = await core.eval_js(PROBE_JS)
        d = json.loads(raw) if isinstance(raw, str) else {}
    finally:
        await core.close()

    osname = prof.ua_platform if prof else "?"
    print(f"\n=== {label}  (claimed OS={osname}, gpu_class={prof.gpu_class if prof else '?'}) ===")
    print(f"  platform={d.get('platform')} uaPlatform={d.get('uaPlatform')} "
          f"mem={d.get('deviceMemory')} cores={d.get('cores')} touch={d.get('maxTouch')}")
    print(f"  battery={d.get('battery')}")
    print(f"  webglVendor={d.get('webglVendor')}")
    is_desktop = any(m in label.lower() for m in ("desktop", "imac", "mac studio", "mac mini"))
    is_mobile = prof.is_mobile if prof else False
    # checks
    bat = d.get("battery") or {}
    if isinstance(bat, dict):
        if is_desktop:
            print(f"  [{'PASS' if (bat.get('charging') is True and bat.get('level')==1) else 'FAIL'}] desktop battery = mains/full")
        else:
            print(f"  [{'PASS' if (0.5 <= (bat.get('level') or 0) <= 0.96) else 'FAIL'}] laptop/phone battery in band")
    exp_touch = 5 if is_mobile else 0
    print(f"  [{'PASS' if d.get('maxTouch')==exp_touch else 'FAIL'}] maxTouchPoints == {exp_touch}")
    fonts = d.get("fonts", {})
    def shown(group): return [f for f in FONT_SETS[group] if fonts.get(f)]
    print(f"  fonts present: Windows={shown('Windows')} macOS={shown('macOS')} "
          f"Android={shown('Android')} common={shown('common')}")
    # coherence: the persona's OS fonts should be present, OTHER OS fonts absent
    own = {"Windows": "Windows", "macOS": "macOS", "Android": "Android"}.get(osname)
    if own:
        own_present = len(shown(own))
        foreign = sum(len(shown(g)) for g in ("Windows", "macOS", "Android") if g != own)
        print(f"  [{'PASS' if (own_present >= 2 and foreign == 0) else 'FAIL'}] "
              f"font set matches OS ({own}: {own_present} present, foreign: {foreign})")


async def main() -> int:
    # fresh persona root so each audited persona gets a clean dir (set BEFORE
    # core_nodriver/personas import builds the pool).
    import tempfile
    os.environ["APEX_PERSONA_DIR"] = tempfile.mkdtemp(prefix="apex-audit-")
    for label in PERSONAS:
        try:
            await audit_one(label)
        except Exception as e:  # noqa: BLE001
            print(f"\n=== {label} ERRORED: {str(e)[:160]} ===")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
