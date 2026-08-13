#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."

. "${REPO_ROOT}/scripts/lib/branch-tag.sh"
. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${SCRIPT_DIR}/deploy.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

cmd_deploy_remote_image_tag() { return 1; }
if cmd_deploy_compute_vars dev feature/test false > /dev/null; then
  fail "failed image resolution returned success"
fi

cmd_deploy_remote_image_tag() { printf '\n'; }
if cmd_deploy_compute_vars dev feature/test false > /dev/null; then
  fail "empty image resolution returned success"
fi

cmd_deploy_validate_image_cohort() { return 1; }
PANDOKS_IMAGE_TAG=ref-main-invalid
export PANDOKS_IMAGE_TAG
if cmd_deploy_compute_vars prod '' false > /dev/null; then
  fail "failed pinned cohort validation returned success"
fi

printf 'deploy shell failure tests passed\n'
