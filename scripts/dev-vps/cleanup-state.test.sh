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
    missing-id)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps"}]}}'
      ;;
    empty-id)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":"  "}]}}'
      ;;
    null-id)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":null}]}}'
      ;;
    object-id)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":{"value":"vps-123"}}]}}'
      ;;
    array-id)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":["vps-123"]}]}}'
      ;;
    boolean-id)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:Vps/vps:Vps::OvhDevBox","type":"ovh:Vps/vps:Vps","id":true}]}}'
      ;;
    missing-service)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":"i-123","inputs":{}}]}}'
      ;;
    empty-service)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":"i-123","inputs":{"serviceName":"  "}}]}}'
      ;;
    object-service)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":"i-123","inputs":{"serviceName":{"value":"service-123"}}}]}}'
      ;;
    null-service)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":"i-123","inputs":{"serviceName":null}}]}}'
      ;;
    array-service)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":"i-123","inputs":{"serviceName":["service-123"]}}]}}'
      ;;
    boolean-service)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":"i-123","inputs":{"serviceName":true}}]}}'
      ;;
    numeric-instance)
      printf '%s\n' '{"deployment":{"resources":[{"urn":"urn:pulumi:pandoks::app::ovh:CloudProject/instance:Instance::OvhDevBox","type":"ovh:CloudProject/instance:Instance","id":123,"inputs":{"serviceName":456}}]}}'
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
  state:remove)
    printf 'attempt:remove:%s\n' "$3" >> "${SST_LOG}"
    if [ "${FAKE_SST_FAIL_REMOVE_NAME:-}" = "$3" ]; then
      exit 42
    fi
    printf 'success:remove:%s\n' "$3" >> "${SST_LOG}"
    ;;
  diff:--stage)
    printf '%s\n' 'attempt:diff' >> "${SST_LOG}"
    if [ "${FAKE_SST_FAIL_DIFF:-}" = 1 ]; then
      exit 43
    fi
    printf '%s' "${FAKE_SST_DIFF:-}"
    ;;
  *) exit 98 ;;
esac
EOF
chmod 0755 "${FAKE_SST}"

run_cleanup() {
  fixture="$1"
  identities="$2"
  action="$3"
  diff_text="${4:-}"
  fail_remove_name="${5:-}"
  fail_diff="${6:-}"
  output="${TMP_ROOT}/output-${fixture}-${action}"
  state_file="${TMP_ROOT}/state-${fixture}.json"
  audit_file="${TMP_ROOT}/audit-${fixture}-${action}"
  make_state "${fixture}" > "${state_file}"
  : > "${SST_LOG}"

  if TMPDIR="${TMP_ROOT}" \
    FAKE_SST_STATE="${state_file}" \
    FAKE_SST_DIFF="${diff_text}" \
    FAKE_SST_FAIL_REMOVE_NAME="${fail_remove_name}" \
    FAKE_SST_FAIL_DIFF="${fail_diff}" \
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
  test "$(grep -c '^attempt:remove:' "${SST_LOG}" || true)" -eq 0 \
    || fail 'empty state attempted a mutation'
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
test "$(grep -c '^attempt:remove:' "${SST_LOG}" || true)" -eq 0 \
  || fail 'unexpected registration-key type removed state'

if run_cleanup hetzner 'h-123' retained-detach; then
  test "$(grep -c '^success:remove:' "${SST_LOG}")" -eq 2 \
    || fail 'Hetzner cleanup removed an unexpected name'
  grep -qx 'success:remove:HetznerDevBox' "${SST_LOG}" \
    || fail 'Hetzner primary was not detached'
  grep -qx 'success:remove:HetznerDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" \
    || fail 'Hetzner key was not detached'
  test "$(sed -n '1p' "${SST_LOG}")" = \
    'attempt:remove:HetznerDevBoxTailnetRegistrationAuthKey' \
    || fail 'Hetzner key was not attempted before the primary'
  grep -q 'retained-manual-service' "${TMP_ROOT}/output-hetzner-retained-detach" \
    || fail 'retained detach action was not explicit'
else
  fail 'Hetzner state cleanup failed'
fi

if run_cleanup ovh-instance 'i-123:service-123' retained-detach; then
  test "$(grep -c '^success:remove:' "${SST_LOG}")" -eq 2 \
    || fail 'OVH instance cleanup removed an unexpected name'
  grep -qx 'success:remove:OvhDevBox' "${SST_LOG}" \
    || fail 'OVH instance primary was not detached'
  grep -qx 'success:remove:OvhDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" \
    || fail 'OVH instance key was not detached'
else
  fail 'OVH instance cleanup failed'
fi

if run_cleanup ovh-vps 'vps-123' already-deleted-stale; then
  test "$(grep -c '^success:remove:' "${SST_LOG}")" -eq 1 \
    || fail 'OVH VPS cleanup removed an unexpected name'
  grep -qx 'success:remove:OvhDevBox' "${SST_LOG}" || fail 'OVH VPS primary was not removed'
  grep -q 'already-deleted-stale' "${TMP_ROOT}/output-ovh-vps-already-deleted-stale" \
    || fail 'stale removal action was not explicit'
else
  fail 'OVH VPS cleanup failed'
fi

for mismatch_case in \
  'hetzner|wrong|wrong Hetzner server ID' \
  'ovh-vps|wrong|wrong OVH VPS service ID' \
  'ovh-instance|wrong:service-123|wrong OVH instance ID' \
  'ovh-instance|i-123:wrong|wrong OVH project/service ID' \
  'hetzner||empty entered Hetzner ID' \
  'ovh-vps||empty entered OVH VPS ID' \
  'ovh-instance|:service-123|empty entered OVH instance ID' \
  'ovh-instance|i-123:|empty entered OVH project/service ID'; do
  fixture="${mismatch_case%%|*}"
  remainder="${mismatch_case#*|}"
  identities="${remainder%%|*}"
  description="${remainder#*|}"
  if run_cleanup "${fixture}" "${identities}" retained-detach; then
    fail "${description} was accepted"
  fi
  test "$(grep -c '^attempt:remove:' "${SST_LOG}" || true)" -eq 0 \
    || fail "${description} attempted a mutation"
done

for invalid_fixture in \
  missing-id empty-id null-id object-id array-id boolean-id \
  missing-service empty-service object-service null-service array-service boolean-service; do
  if run_cleanup "${invalid_fixture}" 'i-123:service-123' retained-detach; then
    fail "${invalid_fixture} exported identity was accepted"
  fi
  test "$(grep -c '^attempt:remove:' "${SST_LOG}" || true)" -eq 0 \
    || fail "${invalid_fixture} exported identity attempted a mutation"
done

if run_cleanup numeric-instance '123:456' retained-detach; then
  grep -qx 'success:remove:OvhDevBox' "${SST_LOG}" \
    || fail 'numeric scalar identities did not normalize to strings'
else
  fail 'numeric scalar exported identities were rejected'
fi

if run_cleanup ovh-vps 'vps-123' ''; then
  fail 'empty cleanup action was accepted'
fi
test "$(grep -c '^attempt:remove:' "${SST_LOG}" || true)" -eq 0 \
  || fail 'empty cleanup action attempted a mutation'

if run_cleanup key-only '' ''; then
  fail 'empty orphan confirmation was accepted'
fi
test "$(grep -c '^attempt:remove:' "${SST_LOG}" || true)" -eq 0 \
  || fail 'empty orphan confirmation attempted a mutation'

if run_cleanup ovh-instance 'i-123:service-123' retained-detach '' \
  OvhDevBoxTailnetRegistrationAuthKey; then
  fail 'key-removal failure was accepted'
fi
grep -qx 'attempt:remove:OvhDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" \
  || fail 'key-removal failure was not attempted'
test "$(grep -c '^success:remove:' "${SST_LOG}" || true)" -eq 0 \
  || fail 'key-removal failure recorded a successful mutation'
test "$(grep -c 'OvhDevBox$' "${SST_LOG}" || true)" -eq 0 \
  || fail 'primary was attempted after key-removal failure'

if run_cleanup ovh-instance 'i-123:service-123' retained-detach '' OvhDevBox; then
  fail 'primary-removal failure was accepted'
fi

grep -qx 'success:remove:OvhDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" \
  || fail 'primary-removal failure did not preserve successful key detachment'
grep -qx 'attempt:remove:OvhDevBox' "${SST_LOG}" \
  || fail 'primary-removal failure was not attempted'
test "$(grep -c '^success:remove:OvhDevBox$' "${SST_LOG}" || true)" -eq 0 \
  || fail 'failed primary removal was recorded as successful'
grep -qx 'attempt:diff' "${SST_LOG}" \
  || fail 'partial completion did not capture a final diff'
grep -qi 'partial completion' "${TMP_ROOT}/output-ovh-instance-retained-detach" \
  || fail 'partial completion was not reported'
grep -qi 'primary remains managed' "${TMP_ROOT}/output-ovh-instance-retained-detach" \
  || fail 'partial completion did not describe the managed primary'
if grep -qi 'no state was changed' "${TMP_ROOT}/output-ovh-instance-retained-detach"; then
  fail 'partial completion incorrectly reported no state change'
fi

if run_cleanup ovh-vps 'vps-123' retained-detach '' OvhDevBox; then
  fail 'primary-only removal failure was accepted'
fi
grep -qx 'attempt:remove:OvhDevBox' "${SST_LOG}" \
  || fail 'primary-only removal failure was not attempted'
test "$(grep -c '^success:remove:' "${SST_LOG}" || true)" -eq 0 \
  || fail 'primary-only removal failure recorded a successful mutation'
test "$(grep -c '^attempt:diff' "${SST_LOG}" || true)" -eq 0 \
  || fail 'primary-only removal failure attempted an unnecessary final diff'
grep -qi 'primary remains managed' "${TMP_ROOT}/output-ovh-vps-retained-detach" \
  || fail 'primary-only removal failure did not describe the managed primary'
grep -qi 'retry safely' "${TMP_ROOT}/output-ovh-vps-retained-detach" \
  || fail 'primary-only removal failure did not provide safe retry guidance'
if grep -qi 'cleanup completed' "${TMP_ROOT}/output-ovh-vps-retained-detach"; then
  fail 'primary-only removal failure incorrectly reported success'
fi

if run_cleanup ovh-instance 'i-123:service-123' retained-detach '' OvhDevBox 1; then
  fail 'primary-removal plus final-diff failure was accepted'
fi
grep -qx 'success:remove:OvhDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" \
  || fail 'partial failure did not preserve successful key detachment'
grep -qx 'attempt:remove:OvhDevBox' "${SST_LOG}" \
  || fail 'partial failure did not attempt the primary removal'
test "$(grep -c '^success:remove:OvhDevBox$' "${SST_LOG}" || true)" -eq 0 \
  || fail 'partial failure recorded the failed primary removal as successful'
grep -qx 'attempt:diff' "${SST_LOG}" \
  || fail 'partial failure did not attempt a final diff'
grep -qi 'partial completion' "${TMP_ROOT}/output-ovh-instance-retained-detach" \
  || fail 'partial failure did not report partial completion'
grep -qi 'diff could not be captured' "${TMP_ROOT}/output-ovh-instance-retained-detach" \
  || fail 'partial failure did not report final-diff capture failure'
grep -qi 'do not apply' "${TMP_ROOT}/output-ovh-instance-retained-detach" \
  || fail 'partial failure did not prohibit applying SST'
grep -qi 'retry the remaining primary record safely' "${TMP_ROOT}/output-ovh-instance-retained-detach" \
  || fail 'partial failure did not provide retry guidance'
if grep -qi -e 'no state was changed' -e 'cleanup completed' \
  "${TMP_ROOT}/output-ovh-instance-retained-detach"; then
  fail 'partial failure incorrectly reported no state change or success'
fi

if run_cleanup key-only '' retained-detach; then
  fail 'key-only orphan was removed without explicit orphan confirmation'
fi
test "$(grep -c '^attempt:remove:' "${SST_LOG}" || true)" -eq 0 \
  || fail 'unconfirmed key-only orphan removed state'

if run_cleanup key-only '' orphan-remove; then
  test "$(grep -c '^success:remove:' "${SST_LOG}")" -eq 1 \
    || fail 'key-only cleanup removed an unexpected name'
  grep -qx 'success:remove:OvhDevBoxTailnetRegistrationAuthKey' "${SST_LOG}" \
    || fail 'key-only orphan was not removed'
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

if grep -R -E \
  'h-123|i-123|service-123|vps-(123|456)|key-[ho]($|[^[:alnum:]-])|secret-[ho]|wrong' \
  "${TMP_ROOT}"/output-*; then
  fail 'cleanup output exposed an identifier or registration key'
fi

printf 'PASS: cleanup state fails closed without printing identities or keys\n'
