#!/bin/sh
# shellcheck shell=sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "${TMP_ROOT}"' EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

make_state() {
  name="$1"
  case "${name}" in
    none)
      printf '%s\n' '{"deployment":{"resources":[]}}'
      ;;
    hetzner)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::hcloud:index/server:Server::HetznerDevBox","type":"hcloud:index/server:Server","id":"h-123"},{"urn":"urn:pulumi:pandoks::app::tailscale:index/tailnetKey:TailnetKey::HetznerDevBoxTailnetRegistrationAuthKey","type":"tailscale:index/tailnetKey:TailnetKey","id":"key-h","outputs":{"key":"secret-h"}}]}}'
      ;;
    ovh-instance)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":"i-123","inputs":{"serviceName":"service-123"}},{"urn":"urn:pulumi:pandoks::app::tailscale:index/tailnetKey:TailnetKey::OvhDevBoxTailnetRegistrationAuthKey","type":"tailscale:index/tailnetKey:TailnetKey","id":"key-o","outputs":{"key":"secret-o"}}]}}'
      ;;
    ovh-vps)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":"vps-123"}]}}'
      ;;
    key-only)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::tailscale:index/tailnetKey:TailnetKey::OvhDevBoxTailnetRegistrationAuthKey","type":"tailscale:index/tailnetKey:TailnetKey","id":"key-o","outputs":{"key":"secret-o"}}]}}'
      ;;
    mixed)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::hcloud:index/server:Server::HetznerDevBox","type":"hcloud:index/server:Server","id":"h-123"},{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":"vps-123"}]}}'
      ;;
    duplicate)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":"vps-123"},{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":"vps-456"}]}}'
      ;;
    cross-provider)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::HetznerDevBox","type":"ovh:Vps/vps:Vps","id":"vps-123"}]}}'
      ;;
    invalid-key)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":"vps-123"},{"urn":"urn:pulumi:pandoks::app::random:index/key:Key::OvhDevBoxTailnetRegistrationAuthKey","type":"random:index/key:Key","id":"key-o"}]}}'
      ;;
    *)
      fail "unknown fixture ${name}"
      ;;
  esac
}

FAKE_SST="${TMP_ROOT}/sst"
SST_LOG="${TMP_ROOT}/sst.log"
export SST_LOG
cat > "${FAKE_SST}" << 'EOF'
#!/bin/sh
set -eu
case "$1:$2" in
  state:export) cat "${FAKE_SST_STATE}" ;;
  state:remove) printf '%s\n' "$3" >> "${SST_LOG}" ;;
  diff:--stage) printf '%s' "${FAKE_SST_DIFF:-}" ;;
  *) exit 98 ;;
esac
EOF
chmod 0755 "${FAKE_SST}"

run_cleanup() {
  fixture="$1"
  identities="$2"
  action="$3"
  diff_text="${4:-}"
  output="${TMP_ROOT}/output-${fixture}-${action}"
  state_file="${TMP_ROOT}/state-${fixture}.json"
  audit_file="${TMP_ROOT}/audit-${fixture}-${action}"
  make_state "${fixture}" > "${state_file}"
  : > "${SST_LOG}"

  if TMPDIR="${TMP_ROOT}" \
    FAKE_SST_STATE="${state_file}" \
    FAKE_SST_DIFF="${diff_text}" \
    DEV_VPS_CLEANUP_TEST_MODE=1 \
    DEV_VPS_CLEANUP_SST_BIN="${FAKE_SST}" \
    DEV_VPS_CLEANUP_TEST_IDENTIFIERS="${identities}" \
    DEV_VPS_CLEANUP_TEST_ACTION="${action}" \
    DEV_VPS_CLEANUP_TEST_AUDIT_FILE="${audit_file}" \
    "${SCRIPT_DIR}/cleanup-state.sh" > "${output}" 2>&1; then
    return 0
  else
    return 1
  fi
}

if run_cleanup none '' retained-detach OvhDevBox; then
  fail 'empty state skipped final diff validation'
fi

if run_cleanup none '' retained-detach; then
  test ! -s "${SST_LOG}" || fail 'empty state attempted a mutation'
else
  fail 'empty state failed'
fi

grep -qx '600:600:600' "${TMP_ROOT}/audit-none-retained-detach" \
  || fail 'temporary state files were not mode 600'

if run_cleanup hetzner 'h-123' retained-detach OvhDevBox; then
  fail 'final diff with a historical dev-box name was accepted'
fi

if run_cleanup mixed '' retained-detach; then
  fail 'mixed families were accepted'
fi
if run_cleanup duplicate '' retained-detach; then
  fail 'duplicate names were accepted'
fi
if run_cleanup cross-provider 'vps-123' retained-detach; then
  fail 'cross-provider primary type was accepted'
fi
test ! -s "${SST_LOG}" || fail 'cross-provider primary type removed state'
if run_cleanup invalid-key 'vps-123' retained-detach; then
  fail 'unexpected registration-key type was accepted'
fi
test ! -s "${SST_LOG}" || fail 'unexpected registration-key type removed state'

if run_cleanup hetzner 'h-123' retained-detach; then
  test "$(wc -l < "${SST_LOG}")" -eq 2 || fail 'Hetzner cleanup removed an unexpected name'
  grep -qx 'HetznerDevBox' "${SST_LOG}" || fail 'Hetzner primary was not detached'
  grep -qx 'HetznerDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" || fail 'Hetzner key was not detached'
  grep -q 'retained-manual-service' "${TMP_ROOT}/output-hetzner-retained-detach" \
    || fail 'retained detach action was not explicit'
else
  fail 'Hetzner state cleanup failed'
fi

if run_cleanup ovh-instance 'i-123:service-123' retained-detach; then
  test "$(wc -l < "${SST_LOG}")" -eq 2 || fail 'OVH instance cleanup removed an unexpected name'
  grep -qx 'OvhDevBox' "${SST_LOG}" || fail 'OVH instance primary was not detached'
  grep -qx 'OvhDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" || fail 'OVH instance key was not detached'
else
  fail 'OVH instance cleanup failed'
fi

if run_cleanup ovh-vps 'vps-123' already-deleted-stale; then
  test "$(wc -l < "${SST_LOG}")" -eq 1 || fail 'OVH VPS cleanup removed an unexpected name'
  grep -qx 'OvhDevBox' "${SST_LOG}" || fail 'OVH VPS primary was not removed'
  grep -q 'already-deleted-stale' "${TMP_ROOT}/output-ovh-vps-already-deleted-stale" \
    || fail 'stale removal action was not explicit'
else
  fail 'OVH VPS cleanup failed'
fi

if run_cleanup ovh-instance 'wrong:service-123' retained-detach; then
  fail 'mismatched identity was accepted'
fi
test ! -s "${SST_LOG}" || fail 'mismatched identity removed state'

if run_cleanup key-only '' retained-detach; then
  fail 'key-only orphan was removed without explicit orphan confirmation'
fi
test ! -s "${SST_LOG}" || fail 'unconfirmed key-only orphan removed state'

if run_cleanup key-only '' orphan-remove; then
  test "$(wc -l < "${SST_LOG}")" -eq 1 || fail 'key-only cleanup removed an unexpected name'
  grep -qx 'OvhDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" || fail 'key-only orphan was not removed'
else
  fail 'key-only orphan cleanup failed'
fi

if find "${TMP_ROOT}" -maxdepth 1 -name 'pandoks-dev-vps-state.*' -print | grep -q .; then
  fail 'state export temporary file was not cleaned up'
fi

if find "${TMP_ROOT}" -maxdepth 1 -name 'pandoks-dev-vps-diff.*' -print | grep -q .; then
  fail 'diff temporary file was not cleaned up'
fi

if find "${TMP_ROOT}" -maxdepth 1 -name 'pandoks-dev-vps-error.*' -print | grep -q .; then
  fail 'error temporary file was not cleaned up'
fi

if grep -R -E 'h-123|i-123|service-123|vps-123|secret-[ho]' "${TMP_ROOT}"/output-*; then
  fail 'cleanup output exposed an identifier or registration key'
fi

printf 'PASS: cleanup state fails closed without printing identities or keys\n'
