#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "${TMP_ROOT}"' EXIT HUP INT TERM

fail() {
  printf "FAIL: %s\n" "$*" >&2
  exit 1
}

DEV_VPS_ROOT="${TMP_ROOT}" DEV_VPS_TEST_MODE=1 "${SCRIPT_DIR}/setup.sh" prepare

test -f "${TMP_ROOT}/etc/sudoers.d/pandoks" \
  || fail "prepare did not create the sudoers file"
grep -q '^pandoks ALL=(ALL) NOPASSWD:ALL$' "${TMP_ROOT}/etc/sudoers.d/pandoks" \
  || fail "sudoers content is incorrect"

if DEV_VPS_ROOT="${TMP_ROOT}" DEV_VPS_TEST_MODE=1 \
  "${SCRIPT_DIR}/setup.sh" lockdown; then
  fail "lockdown succeeded without a verified Tailscale marker"
fi

mkdir -p "${TMP_ROOT}/run"
touch "${TMP_ROOT}/run/tailscale-ssh-verified"
DEV_VPS_ROOT="${TMP_ROOT}" DEV_VPS_TEST_MODE=1 "${SCRIPT_DIR}/setup.sh" lockdown

grep -q 'iifname "tailscale0" tcp dport 22 accept' \
  "${TMP_ROOT}/etc/nftables.conf" \
  || fail "nftables does not restrict SSH to tailscale0"
grep -q 'policy drop' "${TMP_ROOT}/etc/nftables.conf" \
  || fail "nftables is not default-deny"
grep -q '^PasswordAuthentication no$' \
  "${TMP_ROOT}/etc/ssh/sshd_config.d/99-pandoks.conf" \
  || fail "password SSH was not disabled"

DEV_VPS_ROOT="${TMP_ROOT}" DEV_VPS_TEST_MODE=1 "${SCRIPT_DIR}/setup.sh" prepare
DEV_VPS_ROOT="${TMP_ROOT}" DEV_VPS_TEST_MODE=1 "${SCRIPT_DIR}/setup.sh" lockdown

printf "PASS: dev VPS prepare and lockdown are idempotent\n"
