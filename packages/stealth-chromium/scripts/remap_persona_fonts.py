#!/usr/bin/env python3
"""Clone installed faces to the Windows 10/11 persona family names.

The persona-OS font layer (packages/stealth-chromium/Dockerfile) installs a
free font set that covers the Windows 10/11 core family list
(/var/tmp/research/environment-coherence.md section 2.1, verified against
Microsoft's Win10/11 font lists). Only a handful of those families are real
Microsoft binaries (mscorefonts + wine's Tahoma/Symbol/Marlett); the rest are
metric-compatible open-licensed designs (Carlito=Calibri, Caladea=Cambria,
Selawik=Segoe UI, Noto CJK = MS Gothic/Malgun Gothic/Yu Gothic/SimSun/...,
Noto per-script = Ebrima/Leelawadee UI/MV Boli/...).

Skia's SkFontConfigInterfaceDirect::isAcceptableMatch only accepts a match
whose *actual* family name equals the requested one (or is in its metric-compat
table), so a page asking for "Calibri" only resolves if some installed file
really carries the family name "Calibri". This script produces those files:
for each (source, target) it clones the face and rewrites the name table so
the clone's family name is the target persona name. The originals stay
installed; the clones land in /usr/local/share/fonts/apex-persona/.

Licensing: every source is free to redistribute (Microsoft Core Fonts EULA,
SIL OFL 1.1, LGPL 2.1 — see the Dockerfile layer comment). OFL sources are
Renamed Fonts: the clone drops the Reserved Font Names ("Carlito", "Caladea",
"Selawik", Noto) and carries the new name; copyright/notice entries are kept.

Run inside the image build (needs fonttools):
    pip install fonttools && python3 remap_persona_fonts.py && fc-cache -f
"""

import os
import sys

from fontTools.ttLib import TTFont

OUT_DIR = "/usr/local/share/fonts/apex-persona"

# (source path, source family, target family, output basename)
# source family is only used to pick a face out of a .ttc collection; for a
# plain .ttf it is just an assertion that we found the expected file.
MAP = [
    # --- wine fonts with the right name already, just relocate ---
    ("/usr/share/wine/fonts/tahoma.ttf", "Tahoma", "Tahoma", "Tahoma"),
    ("/usr/share/wine/fonts/tahomabd.ttf", "Tahoma", "Tahoma Bold", "Tahoma-Bold"),
    ("/usr/share/wine/fonts/symbol.ttf", "Symbol", "Symbol", "Symbol"),
    ("/usr/share/wine/fonts/marlett.ttf", "Marlett", "Marlett", "Marlett"),
    # --- wine fonts that need the Windows persona name ---
    # wine's ms_sans_serif.ttf is bitmap-only (not FC_SCALABLE), so fontconfig
    # never matches it; rebase on the Arimo face (Arial metrics) instead.
    ("/usr/share/fonts/truetype/croscore/Arimo-Regular.ttf", "Arimo",
     "Microsoft Sans Serif", "MicrosoftSansSerif"),
    # --- metric clones, 4-style sets ---
    ("/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf", "Carlito",
     "Calibri", "Calibri"),
    ("/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf", "Carlito",
     "Calibri Bold", "Calibri-Bold"),
    ("/usr/share/fonts/truetype/crosextra/Carlito-Italic.ttf", "Carlito",
     "Calibri Italic", "Calibri-Italic"),
    ("/usr/share/fonts/truetype/crosextra/Carlito-BoldItalic.ttf", "Carlito",
     "Calibri Bold Italic", "Calibri-BoldItalic"),
    ("/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf", "Caladea",
     "Cambria", "Cambria"),
    ("/usr/share/fonts/truetype/crosextra/Caladea-Bold.ttf", "Caladea",
     "Cambria Bold", "Cambria-Bold"),
    ("/usr/share/fonts/truetype/crosextra/Caladea-Italic.ttf", "Caladea",
     "Cambria Italic", "Cambria-Italic"),
    ("/usr/share/fonts/truetype/crosextra/Caladea-BoldItalic.ttf", "Caladea",
     "Cambria Bold Italic", "Cambria-BoldItalic"),
    ("/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf", "Caladea",
     "Cambria Math", "CambriaMath"),
    # --- Selawik (microsoft/Selawik release 1.01, Segoe UI metrics) ---
    ("/usr/local/share/fonts/selawik/selawk.ttf", "Selawik",
     "Segoe UI", "SegoeUI"),
    ("/usr/local/share/fonts/selawik/selawkb.ttf", "Selawik",
     "Segoe UI Bold", "SegoeUI-Bold"),
    ("/usr/local/share/fonts/selawik/selawkl.ttf", "Selawik",
     "Segoe UI Light", "SegoeUI-Light"),
    ("/usr/local/share/fonts/selawik/selawksb.ttf", "Selawik",
     "Segoe UI Semibold", "SegoeUI-Semibold"),
    ("/usr/local/share/fonts/selawik/selawksl.ttf", "Selawik",
     "Segoe UI Semilight", "SegoeUI-Semilight"),
    # --- remaining Latin set: no metric clone exists, presence + real
    #     glyphs are what the fingerprint needs, so rebase on faces whose
    #     metrics differ from each other and from the real MS set above ---
    ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "DejaVu Sans Mono",
     "Consolas", "Consolas"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "DejaVu Sans Mono",
     "Consolas Bold", "Consolas-Bold"),
    ("/usr/share/fonts/truetype/croscore/Cousine-Regular.ttf", "Cousine",
     "Lucida Console", "LucidaConsole"),
    ("/usr/share/fonts/truetype/croscore/Cousine-Bold.ttf", "Cousine",
     "Lucida Console Bold", "LucidaConsole-Bold"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "DejaVu Serif",
     "Constantia", "Constantia"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf", "DejaVu Serif",
     "Constantia Bold", "Constantia-Bold"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf", "DejaVu Serif",
     "Constantia Italic", "Constantia-Italic"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf", "DejaVu Serif",
     "Constantia Bold Italic", "Constantia-BoldItalic"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans",
     "Candara", "Candara"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVu Sans",
     "Candara Bold", "Candara-Bold"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf", "DejaVu Sans",
     "Candara Italic", "Candara-Italic"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf", "DejaVu Sans",
     "Candara Bold Italic", "Candara-BoldItalic"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf", "DejaVu Sans Condensed",
     "Bahnschrift", "Bahnschrift"),
    ("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "Noto Sans",
     "Corbel", "Corbel"),
    ("/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf", "Noto Sans",
     "Corbel Bold", "Corbel-Bold"),
    ("/usr/share/fonts/truetype/noto/NotoSans-Italic.ttf", "Noto Sans",
     "Corbel Italic", "Corbel-Italic"),
    ("/usr/share/fonts/truetype/noto/NotoSans-BoldItalic.ttf", "Noto Sans",
     "Corbel Bold Italic", "Corbel-BoldItalic"),
    ("/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf", "Noto Serif",
     "Palatino Linotype", "PalatinoLinotype"),
    ("/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf", "Noto Serif",
     "Palatino Linotype Bold", "PalatinoLinotype-Bold"),
    ("/usr/share/fonts/truetype/noto/NotoSerif-Italic.ttf", "Noto Serif",
     "Palatino Linotype Italic", "PalatinoLinotype-Italic"),
    ("/usr/share/fonts/truetype/noto/NotoSerif-BoldItalic.ttf", "Noto Serif",
     "Palatino Linotype Bold Italic", "PalatinoLinotype-BoldItalic"),
    ("/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf", "Noto Serif",
     "Sitka", "Sitka"),
    ("/usr/share/fonts/truetype/croscore/Arimo-Bold.ttf", "Arimo",
     "Franklin Gothic Medium", "FranklinGothicMedium"),
    ("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "Noto Color Emoji",
     "Segoe UI Emoji", "NotoColorEmoji"),
    ("/usr/share/wine/fonts/webdings.ttf", "Webdings", "Webdings", "Webdings"),
    # symbol/icon and handwriting faces: presence is the signal
    ("/usr/share/wine/fonts/symbol.ttf", "Symbol", "Segoe MDL2 Assets",
     "SegoeMDL2Assets"),
    # mscorefonts 3.8.1 dropped Wingdings (dead upstream EXE); the Symbol face
    # covers the presence signal.
    ("/usr/share/wine/fonts/symbol.ttf", "Symbol", "Wingdings", "Wingdings"),
    ("/usr/share/wine/fonts/marlett.ttf", "Marlett", "Hololens MDL2 Assets",
     "HololensMDL2Assets"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans",
     "Segoe Print", "SegoePrint"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans",
     "Segoe Script", "SegoeScript"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans",
     "Segoe UI Historic", "SegoeUIHistoric"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans",
     "Ink Free", "InkFree"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans",
     "Gabriola", "Gabriola"),
    ("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "Noto Sans",
     "Sylfaen", "Sylfaen"),
    # --- CJK (Noto CJK .ttc collections: pick the face by family) ---
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "Noto Sans Mono CJK JP", "MS Gothic", "MSGothic"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
     "Noto Sans Mono CJK JP", "MS Gothic Bold", "MSGothic-Bold"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "Noto Sans Mono CJK JP", "MS PGothic", "MS_PGothic"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "Noto Sans CJK KR", "Malgun Gothic", "MalgunGothic"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
     "Noto Sans CJK KR", "Malgun Gothic Bold", "MalgunGothic-Bold"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "Noto Sans CJK JP", "Yu Gothic", "YuGothic"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
     "Noto Sans CJK JP", "Yu Gothic Bold", "YuGothic-Bold"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "Noto Sans CJK JP", "Yu Gothic UI", "YuGothicUI"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "Noto Sans CJK SC", "Microsoft YaHei", "MicrosoftYaHei"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
     "Noto Sans CJK SC", "Microsoft YaHei Bold", "MicrosoftYaHei-Bold"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "Noto Sans CJK TC", "Microsoft JhengHei", "MicrosoftJhengHei"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
     "Noto Sans CJK TC", "Microsoft JhengHei Bold", "MicrosoftJhengHei-Bold"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
     "Noto Serif CJK SC", "SimSun", "SimSun"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
     "Noto Serif CJK SC", "SimSun Bold", "SimSun-Bold"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
     "Noto Serif CJK JP", "MS Mincho", "MSMincho"),
    ("ttc:/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
     "Noto Serif CJK TC", "MingLiU-ExtB", "MingLiU-ExtB"),
    # --- per-script faces (fonts-noto-core) for the Windows script fonts ---
    ("/usr/share/fonts/truetype/noto/NotoSansNKo-Regular.ttf", "Noto Sans NKo",
     "Ebrima", "Ebrima"),
    ("/usr/share/fonts/truetype/noto/NotoSansJavanese-Regular.ttf", "Noto Sans Javanese",
     "Javanese Text", "JavaneseText"),
    ("/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf", "Noto Sans Thai",
     "Leelawadee UI", "LeelawadeeUI"),
    ("/usr/share/fonts/truetype/noto/NotoSansThaana-Regular.ttf", "Noto Sans Thaana",
     "MV Boli", "MVBoli"),
    ("/usr/share/fonts/truetype/noto/NotoSansMyanmar-Regular.ttf", "Noto Sans Myanmar",
     "Myanmar Text", "MyanmarText"),
    ("/usr/share/fonts/truetype/noto/NotoSansCherokee-Regular.ttf", "Noto Sans Cherokee",
     "Gadugi", "Gadugi"),
    ("/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf", "Noto Sans Devanagari",
     "Nirmala UI", "NirmalaUI"),
    ("/usr/share/fonts/truetype/noto/NotoSansMongolian-Regular.ttf", "Noto Sans Mongolian",
     "Mongolian Baiti", "MongolianBaiti"),
    ("/usr/share/fonts/truetype/noto/NotoSansYi-Regular.ttf", "Noto Sans Yi",
     "Microsoft Yi Baiti", "MicrosoftYiBaiti"),
    ("/usr/share/fonts/truetype/noto/NotoSansTaiLe-Regular.ttf", "Noto Sans Tai Le",
     "Microsoft Tai Le", "MicrosoftTaiLe"),
    ("/usr/share/fonts/truetype/noto/NotoSansNewTaiLue-Regular.ttf", "Noto Sans NewTaiLue",
     "Microsoft New Tai Lue", "MicrosoftNewTaiLue"),
    ("/usr/share/fonts/truetype/noto/NotoSansPhagsPa-Regular.ttf", "Noto Sans PhagsPa",
     "Microsoft PhagsPa", "MicrosoftPhagsPa"),
    ("/usr/share/fonts/truetype/noto/NotoSerifTibetan-Regular.ttf", "Noto Serif Tibetan",
     "Microsoft Himalaya", "MicrosoftHimalaya"),
]


def find_ttc_face(path, want_family):
  """Return (path, fontNumber) for the face inside a .ttc whose family
  matches want_family, else raise."""
  base = path.split(":", 1)[1]
  i = 0
  while True:
    try:
      font = TTFont(base, fontNumber=i, lazy=True)
    except Exception:
      break
    name = font["name"]
    fams = {r.toUnicode() for r in name.names if r.nameID == 1}
    if want_family in fams:
      font.close()
      return base, i
    font.close()
    i += 1
  raise SystemExit(f"face {want_family!r} not found in {path}")


def rename(src, src_fam, want_family, out_path):
  path = src
  font_number = None
  if src.startswith("ttc:"):
    path, font_number = find_ttc_face(src, src_fam)
  font = TTFont(path, fontNumber=font_number) if font_number is not None else TTFont(path)
  name = font["name"]
  # Every clone gets subfamily "Regular": fontconfig ranks a face whose style
  # string is an unusual weight (wine's ms_sans_serif is "Medium") BELOW the
  # default sans, so the exact-name face would never win the match. Variant
  # targets ("Corbel Bold", "Segoe UI Light", ...) are registered as their OWN
  # family -- that is how Windows GDI names them, and it is what makes
  # `fc-match "Corbel Bold"` (and therefore Skia's
  # matchFamilyName("Corbel Bold")) resolve to the bold face. Rendering is
  # unaffected either way: the OS/2 weight metadata is untouched.
  full = f"{want_family} Regular"
  postscript = "".join(c for c in full if c.isalnum())
  for r in list(name.names):
    if r.nameID in (1, 16):
      name.setName(want_family, r.nameID, r.platformID, r.platEncID, r.langID)
    elif r.nameID == 2:
      name.setName("Regular", r.nameID, r.platformID, r.platEncID, r.langID)
    elif r.nameID in (4, 6):
      new = full if r.nameID == 4 else postscript
      name.setName(new, r.nameID, r.platformID, r.platEncID, r.langID)
  font.save(out_path)
  font.close()
  return out_path


def main():
  os.makedirs(OUT_DIR, exist_ok=True)
  written, missing = [], []
  for src, src_fam, target, basename in MAP:
    # verify the source exists and carries the expected family
    probe = src[4:] if src.startswith("ttc:") else src
    if not os.path.exists(probe):
      missing.append((src, target))
      continue
    if not src.startswith("ttc:"):
      found = None
      font = TTFont(probe, lazy=True)
      for r in font["name"].names:
        if r.nameID == 1 and r.toUnicode() == src_fam:
          found = src_fam
      font.close()
      if found is None:
        missing.append((f"{src} (family {src_fam!r})", target))
        continue
    out = os.path.join(OUT_DIR, f"{basename}.ttf")
    rename(src, src_fam, target, out)
    written.append(out)
  for p in written:
    print(f"wrote {p}")
  if missing:
    print("MISSING SOURCES (not remapped):", file=sys.stderr)
    for src, target in missing:
      print(f"  {src} -> {target}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
  main()
