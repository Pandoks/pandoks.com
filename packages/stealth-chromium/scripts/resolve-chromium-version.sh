#!/usr/bin/env bash
# Resolve which Chromium version to build, from chromium_version.txt.
#
# chromium_version.txt accepts EITHER form:
#   * a literal version  "149.0.7827.53"  -> build exactly that (PINNED:
#     reproducible, and how you build an older/specific release).
#   * "latest" | "stable" | empty         -> resolve the newest STABLE release
#     from Google's version-history API at build time (always-current).
#
# Echoes the concrete MAJOR.MINOR.BUILD.PATCH to stdout. Everything that needs
# the version (setup.sh, build.sh, sfn-build.sh) goes through here so the
# literal-vs-latest choice lives in ONE place.
#
# Within a single build the first call caches the resolved value to
# $APEX_CHROMIUM_WORK/.chromium-version-resolved, so every consumer agrees even
# if a newer stable ships mid-build (otherwise setup.sh could check out 149 and
# build.sh key its ccache on 150). Stable is the right channel for a stealth
# browser -- real users run stable, not canary/ToT.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${APEX_CHROMIUM_WORK:-$HOME/apex-chromium-build}"
CACHE="$WORK/.chromium-version-resolved"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'

raw="$(tr -d '[:space:]' < "$ROOT/chromium_version.txt" 2>/dev/null || true)"

# A literal pin: use verbatim, no network needed (reproducible).
if printf '%s' "$raw" | grep -qE "$VERSION_RE"; then
  printf '%s\n' "$raw"
  exit 0
fi

# Otherwise treat it as "latest stable". Within-build memoization.
if [ -f "$CACHE" ] && grep -qE "$VERSION_RE" "$CACHE"; then
  cat "$CACHE"
  exit 0
fi

API="https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions"
resolved=""
for attempt in 1 2 3 4; do
  body="$(curl -fsS --max-time 25 "$API" 2>/dev/null || true)"
  if [ -n "$body" ]; then
    resolved="$(printf '%s' "$body" | jq -r '.versions[0].version' 2>/dev/null || true)"
    if printf '%s' "$resolved" | grep -qE "$VERSION_RE"; then
      break
    fi
  fi
  resolved=""
  sleep $((attempt * 3)) # transient 503s from the API are common; back off
done

if ! printf '%s' "$resolved" | grep -qE "$VERSION_RE"; then
  echo "ERROR: chromium_version.txt requests 'latest' but the version-history" >&2
  echo "       API ($API) could not be resolved after retries. Refusing to" >&2
  echo "       guess a version. Pin a literal version to build offline." >&2
  exit 1
fi

mkdir -p "$WORK" 2>/dev/null || true
printf '%s\n' "$resolved" > "$CACHE" 2>/dev/null || true
printf '%s\n' "$resolved"
