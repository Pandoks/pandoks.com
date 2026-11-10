#!/usr/bin/env bash
# shellcheck shell=bash
# Validation entry for the stealth-browser build.
#
#   scripts/validate_build.sh [--base URL] [--targets local|creep|hard|all]
#                             [--wait N] [--skip-battery]
#
# 1. behavior_attack_suite.py -- the committed detector regression gate
#    (offline, ~0.6s, stdlib-only). A detector regression fails the
#    validation before anything else runs.
# 2. adversarial.py -- the detection-surface battery against the running
#    service (args pass through). Skipped with --skip-battery.
#
# Exit 0 = every gate passed. Any non-zero step fails the run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_BATTERY=0
BATTERY_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--skip-battery" ]; then
    SKIP_BATTERY=1
  else
    BATTERY_ARGS+=("$arg")
  fi
done

echo "==> behavior gate (offline detector regression suite)"
python3 "$SCRIPT_DIR/behavior_attack_suite.py"

if [ "$SKIP_BATTERY" = "1" ]; then
  echo "==> --skip-battery: detection-surface battery not run"
else
  echo "==> detection-surface battery (adversarial.py)"
  exec python3 "$SCRIPT_DIR/adversarial.py" "${BATTERY_ARGS[@]+"${BATTERY_ARGS[@]}"}"
fi
