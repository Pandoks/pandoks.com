#!/usr/bin/env python3
"""Cross-check that the three copies of the Windows 10/11 persona font list
stay identical:

  1. the C++ allowlist    chromium_src/third_party/blink/renderer/platform/
                          fonts/apex_font_policy.h  (kWin[])
  2. the image build gate  scripts/verify_persona_fonts.sh  (NAMES heredoc)
  3. the battery catalog   packages/stealth-browser/stealth_browser/checks.py
                           (fontCatalog.windows)

A family allowed by the C++ gate but missing from the other two is a
coherence bug (check() says present, the width path and the battery say
absent). Run from the repo root:  python3 packages/stealth-chromium/scripts/
check_font_lists.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def extract_sources():
  header = (ROOT / "packages/stealth-chromium/chromium_src/third_party/blink/"
            "renderer/platform/fonts/apex_font_policy.h").read_text()
  gate = (ROOT / "packages/stealth-chromium/scripts/"
          "verify_persona_fonts.sh").read_text()
  battery = (ROOT / "packages/stealth-browser/stealth_browser/"
             "checks.py").read_text()

  cpp_block = re.search(
      r"IsWindowsAllowlistedFont.*?kWin\[\] = \{(.*?)\};", header, re.S)
  if not cpp_block:
    sys.exit("FAIL: no kWin[] table in apex_font_policy.h")
  cpp = {n.lower() for n in re.findall(r'"([^"]+)"', cpp_block.group(1))}

  gate_block = re.search(r"done <<'NAMES'\n(.*?)\nNAMES", gate, re.S)
  if not gate_block:
    sys.exit("FAIL: no NAMES heredoc in verify_persona_fonts.sh")
  gate = {n.strip().lower() for n in gate_block.group(1).splitlines() if n.strip()}

  bat_block = re.search(r"windows: \[(.*?)\],", battery, re.S)
  if not bat_block:
    sys.exit("FAIL: no fontCatalog.windows in checks.py")
  battery = {n.lower() for n in re.findall(r"'([^']+)'", bat_block.group(1))}

  return cpp, gate, battery


def main():
  cpp, gate, battery = extract_sources()
  ok = True
  for label, a, b in (("cpp vs gate", cpp, gate), ("cpp vs battery", cpp, battery)):
    if a != b:
      ok = False
      print(f"FAIL {label}:")
      print(f"  only in first:  {sorted(a - b)}")
      print(f"  only in second: {sorted(b - a)}")
  if ok:
    print(f"ok: {len(cpp)} Windows persona font names identical across "
          "apex_font_policy.h, verify_persona_fonts.sh and checks.py")
  sys.exit(0 if ok else 1)


if __name__ == "__main__":
  main()
