#!/usr/bin/env bash
# Run the full fingerprinter panel pinned to a mobile (Android) persona, so
# CreepJS et al. see a phone. The SFN runs the command as argv (no shell), so an
# "APEX_PROFILE=... bash run-panel.sh" env-prefix does NOT work -- this wrapper
# exports it in-process then hands off to run-panel.sh.
#   command="bash packages/stealth-chromium/scripts/run-panel-mobile.sh"
export APEX_PROFILE="${APEX_PROFILE:-Galaxy S23}"
echo "=== panel pinned to APEX_PROFILE=$APEX_PROFILE ==="
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-panel.sh"
