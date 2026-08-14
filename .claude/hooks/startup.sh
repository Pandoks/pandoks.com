#!/bin/sh

set -eu

cd "${CLAUDE_PROJECT_DIR}" || exit 1
export MISE_TRUSTED_CONFIG_PATHS="${CLAUDE_PROJECT_DIR}"
exec mise install --yes 1>&2
