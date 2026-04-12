"""Subset a font to specific characters at a single weight, output base64 woff2 to stdout."""
import sys
import base64
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

font_path = sys.argv[1]
chars = sys.argv[2]
weight = int(sys.argv[3]) if len(sys.argv) > 3 else None

font = TTFont(font_path)

# Pin to single weight if variable font
if weight and 'fvar' in font:
    from fontTools.varLib.instancer import instantiateVariableFont
    instantiateVariableFont(font, {"wght": weight}, inplace=True, overlap=True)

# Subset to just the needed codepoints
cps = set(ord(c) for c in chars)
options = Options()
options.flavor = 'woff2'
options.layout_features = ['kern', 'liga']
options.notdef_outline = True
options.prune_unicode_ranges = True

subsetter = Subsetter(options=options)
subsetter.populate(unicodes=cps)
subsetter.subset(font)

font.flavor = 'woff2'
import io
buf = io.BytesIO()
font.save(buf)
font.close()

sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
