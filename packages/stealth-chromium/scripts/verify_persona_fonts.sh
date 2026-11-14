#!/bin/sh
# Build gate for the persona-OS font layer (packages/stealth-chromium/Dockerfile).
#
# Verifies that every Windows 10/11 persona family name RESOLVES in the image
# the way Skia will accept it. Skia's SkFontConfigInterfaceDirect::isAcceptableMatch
# (third_party/skia/src/ports/SkFontConfigInterface_direct.cpp) accepts a match
# when ANY of these hold, case-insensitively:
#   1. post_config_family == post_match_family  (fontconfig's config rewrite
#      landed on the matched face's own name)
#   2. requested family == post_match_family    (the face really is that family)
#   3. IsMetricCompatibleReplacement(request, post_match_family)
# A name that fails all three is treated by Blink as "not installed", so the
# width-measurement path and document.fonts.check() would disagree -- which is
# itself a detector signal. This gate makes the image build fail instead.
#
# The name list must stay in sync with the Windows allowlist in
# chromium_src/third_party/blink/renderer/platform/fonts/apex_font_policy.h
# and the battery's catalog list in stealth_browser/checks.py.
set -eu

fail=0
check_name() {
  req="$1"
  req_low=$(printf '%s' "$req" | tr '[:upper:]' '[:lower:]')
  post_config=$(fc-pattern -c -- "$req" 2> /dev/null | sed -n 's/^\tfamily: "\([^"]*\)".*/\1/p' | head -1)
  [ -z "$post_config" ] && post_config="$req"
  match_file=$(fc-match -f '%{file}' -- "$req" 2> /dev/null)
  [ -z "$match_file" ] && {
    printf '  FAIL  %s (no match)\n' "$req"
    fail=$((fail + 1))
    return
  }
  accepted_file=$(mktemp)
  match_fams=$(fc-scan --format '%{family}' "$match_file" 2> /dev/null | tr ',' '\n' | tr '[:upper:]' '[:lower:]')
  accepted=0
  printf '%s\n' "$match_fams" | while IFS= read -r fam; do
    [ -z "$fam" ] && continue
    if [ "$fam" = "$req_low" ] || [ "$fam" = "$(printf '%s' "$post_config" | tr '[:upper:]' '[:lower:]')" ]; then
      echo 1 > "$accepted_file"
    fi
  done
  [ -s "$accepted_file" ] && accepted=1
  rm -f "$accepted_file"
  if [ "$accepted" -eq 0 ]; then
    printf '  FAIL  %s (post_config=%s match=%s fams=%s)\n' "$req" "$post_config" "$match_file" "$(printf '%s' "$match_fams" | tr '\n' ',')"
    fail=$((fail + 1))
  fi
}

while IFS= read -r name; do
  [ -z "$name" ] && continue
  check_name "$name"
done << 'NAMES'
Segoe UI
Segoe UI Bold
Segoe UI Light
Segoe UI Semibold
Segoe UI Semilight
Arial
Arial Black
Calibri
Calibri Bold
Cambria
Cambria Bold
Cambria Math
Candara
Candara Bold
Comic Sans MS
Consolas
Consolas Bold
Constantia
Constantia Bold
Corbel
Corbel Bold
Courier New
Ebrima
Franklin Gothic Medium
Gabriola
Gadugi
Georgia
Hololens MDL2 Assets
Impact
Ink Free
Javanese Text
Leelawadee UI
Lucida Console
Lucida Console Bold
Malgun Gothic
Marlett
Microsoft Sans Serif
Microsoft YaHei
Microsoft JhengHei
Mongolian Baiti
MS Gothic
MS PGothic
MS Mincho
MV Boli
Myanmar Text
Nirmala UI
Palatino Linotype
Segoe MDL2 Assets
Segoe Print
Segoe Script
Segoe UI Historic
Segoe UI Emoji
SimSun
Sitka
Sylfaen
Symbol
Tahoma
Times New Roman
Trebuchet MS
Verdana
Webdings
Wingdings
Yu Gothic
NAMES

if [ "$fail" -gt 0 ]; then
  printf 'verify_persona_fonts: %d persona name(s) do not resolve\n' "$fail" >&2
  exit 1
fi
printf 'verify_persona_fonts: all persona names resolve\n'
