#!/usr/bin/env bash
# Build PER-OS font sets so each persona exposes ONLY its own OS's fonts.
#
# Why: the font fingerprint = the SET of fonts a page can detect (width probes).
# A single Linux box with every font installed makes a "macOS" persona show
# Calibri (Windows) and a "Windows" persona show Roboto (Android) -- incoherent.
# Fix: three font dirs + three fontconfig files; the browser sets FONTCONFIG_FILE
# per persona (core_nodriver), so fontconfig serves ONLY that OS's set.
#
# Coverage: Windows = real MS core fonts (Arial/Times/Courier/Verdana/Georgia/
# ...) + Carlito(Calibri)/Caladea(Cambria) metric clones. Android = Roboto/Noto/
# Droid. macOS = TeX Gyre Heros(Helvetica)/Termes(Times)/Cursor(Courier) + Noto;
# the macOS-EXCLUSIVE faces (Helvetica Neue, SF Pro, Menlo, Lucida Grande) have
# no free clones, so macOS is PARTIAL -- but it no longer shows foreign-OS fonts.
# The bundled 30-metric-aliases.conf maps Calibri->Carlito, Helvetica->TeX Gyre
# Heros etc.; we <include> it so the original NAMES resolve, gated by which
# clone is actually present in each OS dir.
set -uo pipefail
ROOT="${APEX_FONT_ROOT:-/opt/apex-fonts}"
export DEBIAN_FRONTEND=noninteractive

echo "[fonts] installing packages"
sudo apt-get update -qq || true
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
  | sudo debconf-set-selections 2>/dev/null || true
sudo apt-get install -y -qq fontconfig ttf-mscorefonts-installer \
  fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation \
  fonts-roboto fonts-noto-core fonts-droid-fallback fonts-texgyre \
  >/dev/null 2>&1 || sudo apt-get install -y -qq fontconfig fonts-liberation \
  fonts-roboto fonts-noto-core >/dev/null 2>&1 || true

sudo mkdir -p "$ROOT/windows" "$ROOT/macos" "$ROOT/android"

# copy_glob <dest> <name-substr>...  -- copy matching font files from the system
copy_glob() {
  dest="$1"; shift
  for pat in "$@"; do
    find /usr/share/fonts -type f \( -iname '*.ttf' -o -iname '*.otf' \) \
      -iname "*${pat}*" 2>/dev/null | while read -r f; do
      sudo cp -n "$f" "$dest/" 2>/dev/null || true
    done
  done
}

echo "[fonts] windows set"
copy_glob "$ROOT/windows" Arial Times_New_Roman Courier_New Verdana Georgia \
  Trebuchet Comic Impact Andale Webdings Carlito Caladea
echo "[fonts] macos set (Helvetica/Times/Courier substitutes + Noto base)"
copy_glob "$ROOT/macos" texgyreheros texgyretermes texgyrecursor NotoSans NotoSerif
echo "[fonts] android set"
copy_glob "$ROOT/android" Roboto NotoSans NotoSerif Droid

# write one fontconfig per OS: ONLY that dir + the metric-alias rules so the
# original family names (Calibri, Helvetica, ...) resolve to the present clones.
write_conf() {
  os="$1"; sans="$2"; serif="$3"; mono="$4"
  cat <<EOF | sudo tee "$ROOT/$os.conf" >/dev/null
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$ROOT/$os</dir>
  <cachedir>/tmp/apex-fc/$os</cachedir>
  <include ignore_missing="yes">/etc/fonts/conf.d/30-metric-aliases.conf</include>
  <alias><family>sans-serif</family><prefer><family>$sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>$serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>$mono</family></prefer></alias>
</fontconfig>
EOF
  sudo mkdir -p "/tmp/apex-fc/$os"
  FONTCONFIG_FILE="$ROOT/$os.conf" fc-cache -f "$ROOT/$os" >/dev/null 2>&1 || true
  n=$(FONTCONFIG_FILE="$ROOT/$os.conf" fc-list 2>/dev/null | wc -l)
  echo "[fonts] $os: $n font files, conf=$ROOT/$os.conf"
}
write_conf windows Arial "Times New Roman" "Courier New"
write_conf macos Helvetica Times Courier
write_conf android Roboto "Noto Serif" "Roboto Mono"
echo "[fonts] done -> $ROOT"
