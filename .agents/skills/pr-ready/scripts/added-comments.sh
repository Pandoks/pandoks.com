#!/bin/sh
# Lists comment lines added by a unified diff as file:line: text.
set -eu

awk '
  /^diff --git / { in_hunk = 0; next }
  /^\+\+\+ [ab\/]/ && !in_hunk { file = substr($0, 7); next }
  /^@@ / {
    split($3, range, ",")
    line = substr(range[1], 2)
    in_hunk = 1
    next
  }
  /^\+/ {
    text = substr($0, 2)
    line++
    if (file ~ /(\.(md|txt|json|lock|sum)|go\.mod)$/) next
    trimmed = text
    sub(/^[ \t]+/, "", trimmed)
    if (trimmed ~ /^(#!|# (renovate|shellcheck|hadolint|yaml-language-server|syntax=|options:)|\/\/ ?(eslint|@ts-|go:|nolint|prettier)|#nosec|--- ?@)/) next
    dashes = file ~ /\.(lua|sql)$/
    whole = trimmed ~ /^(#|\/\/|<!--|\/\*|\{\/\*)/ || (dashes && trimmed ~ /^--/) || (file ~ /\.(tsx?|jsx?|mjs|svelte|go|c|h|m|css)$/ && trimmed ~ /^\*/)
    trailing = (text ~ /[ \t](#|\/\/) / || (dashes && text ~ /[ \t]-- /)) && text !~ /[ \t]# (v?[0-9][0-9.]*[ \t]*$|renovate:|shellcheck )/ && text !~ /\/\/ indirect$/
    if (trailing && !whole && match(text, /[ \t](#|\/\/|--) /)) {
      before = substr(text, 1, RSTART)
      if (gsub(/"/, "", before) % 2 == 1) trailing = 0
    }
    if (whole || trailing) print file ":" line - 1 ": " trimmed
  }
'
