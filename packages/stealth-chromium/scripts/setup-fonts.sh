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
# install each package independently so one missing package can't abort the set
for pkg in fontconfig ttf-mscorefonts-installer fonts-crosextra-carlito \
  fonts-crosextra-caladea fonts-liberation fonts-roboto fonts-noto-core \
  fonts-droid-fallback fonts-texgyre fonts-urw-base35; do
  sudo apt-get install -y -qq "$pkg" >/dev/null 2>&1 || true
done

sudo mkdir -p "$ROOT/windows" "$ROOT/macos" "$ROOT/android"

# copy_glob <dest> <name-substr>...  -- copy matching font files from the system
# (search the font tree + the TeX tree, since fonts-texgyre lands outside
# /usr/share/fonts on some distros).
copy_glob() {
  dest="$1"; shift
  for pat in "$@"; do
    find /usr/share/fonts /usr/share/texmf /usr/share/texlive \
      /usr/local/share/fonts -type f \( -iname '*.ttf' -o -iname '*.otf' \) \
      -iname "*${pat}*" 2>/dev/null | while read -r f; do
      sudo cp -n "$f" "$dest/" 2>/dev/null || true
    done
  done
}

echo "[fonts] windows set"
copy_glob "$ROOT/windows" Arial Times_New_Roman Courier_New Verdana Georgia \
  Trebuchet Comic Impact Andale Webdings Carlito Caladea
# macOS ships the MS web-core fonts (Arial/Times New Roman/Courier New/Georgia/
# Verdana/Trebuchet/Comic Sans/Impact) AND Helvetica -- but NOT Calibri/Cambria
# (Windows-only) or Roboto/Noto (Android/Linux). So: MS web fonts + Nimbus/TeX
# Gyre Helvetica/Times/Courier clones, NO Carlito/Caladea, NO Noto.
echo "[fonts] macos set (MS web fonts + Helvetica/Times/Courier clones)"
copy_glob "$ROOT/macos" Arial Times_New_Roman Courier_New Georgia Verdana \
  Trebuchet Comic Impact Andale NimbusSans NimbusRoman NimbusMono \
  texgyreheros texgyretermes texgyrecursor
echo "[fonts] android set"
copy_glob "$ROOT/android" Roboto NotoSans NotoSerif Droid

# write one fontconfig per OS: ONLY that dir + the metric-alias rules so the
# original family names (Calibri, Helvetica, ...) resolve to the present clones.
write_conf() {
  os="$1"; sans="$2"; serif="$3"; mono="$4"; extra="${5:-}"
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
$extra
</fontconfig>
EOF
  sudo mkdir -p "/tmp/apex-fc/$os"
  FONTCONFIG_FILE="$ROOT/$os.conf" fc-cache -f "$ROOT/$os" >/dev/null 2>&1 || true
  n=$(FONTCONFIG_FILE="$ROOT/$os.conf" fc-list 2>/dev/null | wc -l)
  echo "[fonts] $os: $n font files, conf=$ROOT/$os.conf"
}
write_conf windows Arial "Times New Roman" "Courier New"
# macOS: map the classic Mac faces to the present Nimbus/TeX Gyre clones so a
# width probe for Helvetica / Helvetica Neue / Times / Courier resolves. (The
# Mac-EXCLUSIVE faces -- SF Pro, Menlo, Geneva, Lucida Grande -- have no free
# clone and stay absent; documented residual.)
_mac_alias='  <alias><family>Helvetica</family><accept><family>Nimbus Sans</family><family>TeX Gyre Heros</family></accept></alias>
  <alias><family>Helvetica Neue</family><accept><family>Nimbus Sans</family><family>TeX Gyre Heros</family></accept></alias>
  <alias><family>Times</family><accept><family>Nimbus Roman</family><family>TeX Gyre Termes</family></accept></alias>
  <alias><family>Courier</family><accept><family>Nimbus Mono PS</family><family>TeX Gyre Cursor</family></accept></alias>'
write_conf macos Helvetica Times Courier "$_mac_alias"
write_conf android Roboto "Noto Serif" "Roboto Mono"
echo "[fonts] done -> $ROOT"
