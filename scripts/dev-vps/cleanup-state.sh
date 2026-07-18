#!/bin/sh
# shellcheck shell=sh

set -eu
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPOSITORY_ROOT="$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPOSITORY_ROOT}"
TEST_MODE="${DEV_VPS_CLEANUP_TEST_MODE:-0}"
STAGE="pandoks"
STATE_FILE=
DIFF_FILE=
ERROR_FILE=
TTY_STATE=

cleanup() {
  for cleanup_file in "${STATE_FILE}" "${DIFF_FILE}" "${ERROR_FILE}"; do
    if [ -n "${cleanup_file}" ]; then
      rm -f "${cleanup_file}"
    else
      :
    fi
  done
}

restore_tty() {
  if [ -n "${TTY_STATE}" ]; then
    if stty "${TTY_STATE}" < /dev/tty; then
      :
    else
      :
    fi
    if printf '\n' > /dev/tty; then
      :
    else
      :
    fi
    TTY_STATE=
  else
    :
  fi
}

on_exit() {
  restore_tty
  cleanup
}

trap 'on_exit' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/pandoks-dev-vps-state.XXXXXXXX")"
DIFF_FILE="$(mktemp "${TMPDIR:-/tmp}/pandoks-dev-vps-diff.XXXXXXXX")"
ERROR_FILE="$(mktemp "${TMPDIR:-/tmp}/pandoks-dev-vps-error.XXXXXXXX")"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

ensure_private_temp_files() {
  if state_mode="$(stat -f '%Lp' "${STATE_FILE}" 2> /dev/null)"; then
    :
  elif state_mode="$(stat -c '%a' "${STATE_FILE}" 2> /dev/null)"; then
    :
  else
    fail 'Could not verify the private state export file mode.'
  fi
  if diff_mode="$(stat -f '%Lp' "${DIFF_FILE}" 2> /dev/null)"; then
    :
  elif diff_mode="$(stat -c '%a' "${DIFF_FILE}" 2> /dev/null)"; then
    :
  else
    fail 'Could not verify the private diff file mode.'
  fi
  if error_mode="$(stat -f '%Lp' "${ERROR_FILE}" 2> /dev/null)"; then
    :
  elif error_mode="$(stat -c '%a' "${ERROR_FILE}" 2> /dev/null)"; then
    :
  else
    fail 'Could not verify the private error file mode.'
  fi
  if [ "${state_mode}" = 600 ] && [ "${diff_mode}" = 600 ] && [ "${error_mode}" = 600 ]; then
    :
  else
    fail 'Temporary cleanup files are not private; do not continue.'
  fi

  if [ "${TEST_MODE}" = 1 ] && [ -n "${DEV_VPS_CLEANUP_TEST_AUDIT_FILE:-}" ]; then
    if printf '%s\n' "${state_mode}:${diff_mode}:${error_mode}" > "${DEV_VPS_CLEANUP_TEST_AUDIT_FILE}"; then
      :
    else
      fail 'Could not write the private test audit record.'
    fi
  else
    :
  fi
}

if [ "${TEST_MODE}" = 1 ]; then
  if [ -n "${DEV_VPS_CLEANUP_SST_BIN:-}" ]; then
    SST_BIN="${DEV_VPS_CLEANUP_SST_BIN}"
  else
    fail 'Test mode requires DEV_VPS_CLEANUP_SST_BIN.'
  fi
else
  if [ -z "${DEV_VPS_CLEANUP_SST_BIN:-}" ]; then
    SST_BIN="${REPOSITORY_ROOT}/node_modules/.bin/sst"
  else
    fail 'DEV_VPS_CLEANUP_SST_BIN is available only in test mode.'
  fi
fi

if [ -x "${SST_BIN}" ]; then
  :
else
  fail 'The local SST binary is not executable; do not continue.'
fi

ensure_private_temp_files

if "${SST_BIN}" state export --stage "${STAGE}" > "${STATE_FILE}" 2> "${ERROR_FILE}"; then
  :
else
  fail 'SST state export failed; no state was changed.'
fi

resource_count() {
  logical_name="$1"
  jq -e --arg suffix "::${logical_name}" '
    [.deployment.resources[]? | select(.urn | endswith($suffix))] | length
  ' "${STATE_FILE}"
}

resource_scalar_field() {
  logical_name="$1"
  field="$2"
  jq -er --arg suffix "::${logical_name}" --arg field "${field}" '
    def normalized_scalar:
      if type == "string" then
        gsub("^\\s+|\\s+$"; "")
      elif type == "number" then
        tostring
      else
        empty
      end;
    [.deployment.resources[]? | select(.urn | endswith($suffix))]
    | if length == 1 then .[0][$field] else empty end
    | normalized_scalar
    | select(length > 0)
    | select(explode | all(. >= 32 and . != 127))
  ' "${STATE_FILE}"
}

resource_scalar_service_name() {
  logical_name="$1"
  jq -er --arg suffix "::${logical_name}" '
    def normalized_scalar:
      if type == "string" then
        gsub("^\\s+|\\s+$"; "")
      elif type == "number" then
        tostring
      else
        empty
      end;
    [.deployment.resources[]? | select(.urn | endswith($suffix))]
    | if length == 1 then .[0].inputs.serviceName else empty end
    | normalized_scalar
    | select(length > 0)
    | select(explode | all(. >= 32 and . != 127))
  ' "${STATE_FILE}"
}

require_resource_field() {
  logical_name="$1"
  field="$2"
  if required_value="$(resource_scalar_field "${logical_name}" "${field}")"; then
    printf '%s' "${required_value}"
  else
    fail 'A required exported state identity field is missing or invalid; no state was changed.'
  fi
}

require_resource_service_name() {
  logical_name="$1"
  if required_value="$(resource_scalar_service_name "${logical_name}")"; then
    printf '%s' "${required_value}"
  else
    fail 'A required exported state identity field is missing or invalid; no state was changed.'
  fi
}

normalize_entered_identity() {
  entered_value="$1"
  if normalized_value="$(printf '%s' "${entered_value}" | jq -Rer '
    gsub("^\\s+|\\s+$"; "")
    | select(length > 0)
    | select(explode | all(. >= 32 and . != 127))
  ')"; then
    printf '%s' "${normalized_value}"
  else
    fail 'A required identity confirmation was empty or invalid; no state was changed.'
  fi
}

HETZNER_PRIMARY_COUNT="$(resource_count HetznerDevBox)"
HETZNER_KEY_COUNT="$(resource_count HetznerDevBoxTailnetRegistrationAuthKey)"
OVH_PRIMARY_COUNT="$(resource_count OvhDevBox)"
OVH_KEY_COUNT="$(resource_count OvhDevBoxTailnetRegistrationAuthKey)"

for count in "${HETZNER_PRIMARY_COUNT}" "${HETZNER_KEY_COUNT}" \
  "${OVH_PRIMARY_COUNT}" "${OVH_KEY_COUNT}"; do
  if [ "${count}" = 0 ] || [ "${count}" = 1 ]; then
    :
  else
    fail 'Historical dev-box state records are duplicated or ambiguous; no state was changed.'
  fi
done

if [ "${HETZNER_PRIMARY_COUNT}" = 0 ] && [ "${HETZNER_KEY_COUNT}" = 0 ]; then
  HETZNER_PRESENT=false
else
  HETZNER_PRESENT=true
fi

if [ "${OVH_PRIMARY_COUNT}" = 0 ] && [ "${OVH_KEY_COUNT}" = 0 ]; then
  OVH_PRESENT=false
else
  OVH_PRESENT=true
fi

if [ "${HETZNER_PRESENT}" = true ] && [ "${OVH_PRESENT}" = true ]; then
  fail 'Historical dev-box state records mix Hetzner and OVH families; no state was changed.'
elif [ "${HETZNER_PRESENT}" = true ]; then
  FAMILY=hetzner
  PRIMARY_COUNT="${HETZNER_PRIMARY_COUNT}"
  KEY_COUNT="${HETZNER_KEY_COUNT}"
  PRIMARY_NAME=HetznerDevBox
  KEY_NAME=HetznerDevBoxTailnetRegistrationAuthKey
elif [ "${OVH_PRESENT}" = true ]; then
  FAMILY=ovh
  PRIMARY_COUNT="${OVH_PRIMARY_COUNT}"
  KEY_COUNT="${OVH_KEY_COUNT}"
  PRIMARY_NAME=OvhDevBox
  KEY_NAME=OvhDevBoxTailnetRegistrationAuthKey
else
  printf '%s\n' 'No historical dev-box state record is present; no state was changed.'
  FAMILY=none
  PRIMARY_COUNT=0
  KEY_COUNT=0
  PRIMARY_NAME=
  KEY_NAME=
fi

if [ "${KEY_COUNT}" = 1 ]; then
  KEY_TYPE="$(require_resource_field "${KEY_NAME}" type)"
  if [ "${KEY_TYPE}" = 'tailscale:index/tailnetKey:TailnetKey' ]; then
    :
  else
    fail 'The registration-key row has an unexpected provider type; no state was changed.'
  fi
else
  :
fi

capture_final_diff() {
  "${SST_BIN}" diff --stage "${STAGE}" > "${DIFF_FILE}" 2> "${ERROR_FILE}"
}

report_partial_completion() {
  if capture_final_diff; then
    printf '%s\n' \
      'Partial completion: the registration-key state record was detached, but the primary remains managed.' \
      'A final SST diff was captured privately. Do not apply it.' \
      'Re-run this cleanup helper to validate and retry the remaining primary record safely.' >&2
  else
    printf '%s\n' \
      'Partial completion: the registration-key state record was detached, but the primary remains managed.' \
      'The final SST diff could not be captured. Do not apply SST.' \
      'Restore provider access, then re-run this cleanup helper to validate and retry the remaining primary record safely.' >&2
  fi
  exit 1
}

read_hidden() {
  prompt="$1"
  if printf '%s' "${prompt}" > /dev/tty; then
    :
  else
    fail 'No controlling terminal is available for identity confirmation.'
  fi
  if TTY_STATE="$(stty -g < /dev/tty)"; then
    :
  else
    fail 'Could not record terminal settings for identity confirmation.'
  fi
  if stty -echo < /dev/tty; then
    :
  else
    fail 'Could not disable terminal echo for identity confirmation.'
  fi
  if IFS= read -r REPLY < /dev/tty; then
    :
  else
    fail 'Could not read identity confirmation.'
  fi
  if stty "${TTY_STATE}" < /dev/tty; then
    TTY_STATE=
  else
    fail 'Could not restore terminal echo after identity confirmation.'
  fi
  if printf '\n' > /dev/tty; then
    :
  else
    fail 'Could not complete identity confirmation.'
  fi
}

test_identity_values() {
  if [ -n "${DEV_VPS_CLEANUP_TEST_IDENTIFIERS:-}" ]; then
    TEST_IDENTIFIERS="${DEV_VPS_CLEANUP_TEST_IDENTIFIERS}"
  else
    TEST_IDENTIFIERS=''
  fi
}

choose_action() {
  if [ "${TEST_MODE}" = 1 ]; then
    if [ -n "${DEV_VPS_CLEANUP_TEST_ACTION:-}" ]; then
      ACTION="${DEV_VPS_CLEANUP_TEST_ACTION}"
    else
      fail 'Test mode requires DEV_VPS_CLEANUP_TEST_ACTION.'
    fi
  else
    printf '%s' 'Type retained-detach or already-deleted-stale: ' > /dev/tty
    if IFS= read -r ACTION < /dev/tty; then
      :
    else
      fail 'Could not read the cleanup action; no state was changed.'
    fi
  fi

  if [ "${ACTION}" = retained-detach ]; then
    printf '%s\n' 'Confirmed retained-manual-service action: SST state will be detached only.'
  elif [ "${ACTION}" = already-deleted-stale ]; then
    printf '%s\n' 'Confirmed already-deleted-stale action: stale SST state will be removed only.'
  else
    fail 'A recognized cleanup action was not confirmed; no state was changed.'
  fi
}

confirm_orphan_removal() {
  if [ "${TEST_MODE}" = 1 ]; then
    if [ -n "${DEV_VPS_CLEANUP_TEST_ACTION:-}" ]; then
      ACTION="${DEV_VPS_CLEANUP_TEST_ACTION}"
    else
      fail 'Test mode requires DEV_VPS_CLEANUP_TEST_ACTION.'
    fi
  else
    printf '%s' 'Type orphan-remove to remove the exact key-only state record: ' > /dev/tty
    if IFS= read -r ACTION < /dev/tty; then
      :
    else
      fail 'Could not read the orphan cleanup confirmation; no state was changed.'
    fi
  fi

  if [ "${ACTION}" = orphan-remove ]; then
    printf '%s\n' 'Confirmed exact key-only orphan removal.'
  else
    fail 'The exact key-only orphan removal was not confirmed; no state was changed.'
  fi
}

if [ "${PRIMARY_COUNT}" = 0 ]; then
  if [ "${KEY_COUNT}" = 1 ]; then
    printf '%s\n' 'Only one exact registration-key state record is present; explicit confirmation is required.'
    confirm_orphan_removal
    if "${SST_BIN}" state remove "${KEY_NAME}" --stage "${STAGE}" > /dev/null 2> "${ERROR_FILE}"; then
      :
    else
      fail 'The registration-key orphan could not be removed; do not continue.'
    fi
  elif [ "${KEY_COUNT}" = 0 ] && [ "${FAMILY}" = none ]; then
    :
  else
    fail 'No primary record is present but cleanup state is inconsistent; no state was changed.'
  fi
else
  PRIMARY_TYPE="$(require_resource_field "${PRIMARY_NAME}" type)"
  if [ "${FAMILY}" = hetzner ] && [ "${PRIMARY_TYPE}" = 'hcloud:index/server:Server' ]; then
    STATE_PRIMARY_ID="$(require_resource_field "${PRIMARY_NAME}" id)"
    if [ "${TEST_MODE}" = 1 ]; then
      test_identity_values
      ENTERED_PRIMARY_ID="${TEST_IDENTIFIERS}"
    else
      read_hidden 'Expected Hetzner server ID from Control Panel: '
      ENTERED_PRIMARY_ID="${REPLY}"
      REPLY=''
    fi
    ENTERED_PRIMARY_ID="$(normalize_entered_identity "${ENTERED_PRIMARY_ID}")"
    if [ "${ENTERED_PRIMARY_ID}" = "${STATE_PRIMARY_ID}" ]; then
      :
    else
      fail 'The confirmed physical identity does not match exported state; no state was changed.'
    fi
  elif [ "${FAMILY}" = ovh ] && [ "${PRIMARY_TYPE}" = 'ovh:CloudProject/instance:Instance' ]; then
    STATE_INSTANCE_ID="$(require_resource_field "${PRIMARY_NAME}" id)"
    STATE_SERVICE_ID="$(require_resource_service_name "${PRIMARY_NAME}")"
    if [ "${TEST_MODE}" = 1 ]; then
      test_identity_values
      ENTERED_INSTANCE_ID="${TEST_IDENTIFIERS%%:*}"
      ENTERED_SERVICE_ID="${TEST_IDENTIFIERS#*:}"
    else
      read_hidden 'Expected OVH Public Cloud instance ID from Control Panel: '
      ENTERED_INSTANCE_ID="${REPLY}"
      REPLY=''
      read_hidden 'Expected OVH Public Cloud project/service ID from Control Panel: '
      ENTERED_SERVICE_ID="${REPLY}"
      REPLY=''
    fi
    ENTERED_INSTANCE_ID="$(normalize_entered_identity "${ENTERED_INSTANCE_ID}")"
    ENTERED_SERVICE_ID="$(normalize_entered_identity "${ENTERED_SERVICE_ID}")"
    if [ "${ENTERED_INSTANCE_ID}" = "${STATE_INSTANCE_ID}" ] && [ "${ENTERED_SERVICE_ID}" = "${STATE_SERVICE_ID}" ]; then
      :
    else
      fail 'The confirmed physical identity does not match exported state; no state was changed.'
    fi
  elif [ "${FAMILY}" = ovh ] && [ "${PRIMARY_TYPE}" = 'ovh:Vps/vps:Vps' ]; then
    STATE_PRIMARY_ID="$(require_resource_field "${PRIMARY_NAME}" id)"
    if [ "${TEST_MODE}" = 1 ]; then
      test_identity_values
      ENTERED_PRIMARY_ID="${TEST_IDENTIFIERS}"
    else
      read_hidden 'Expected OVH VPS service ID from Control Panel: '
      ENTERED_PRIMARY_ID="${REPLY}"
      REPLY=''
    fi
    ENTERED_PRIMARY_ID="$(normalize_entered_identity "${ENTERED_PRIMARY_ID}")"
    if [ "${ENTERED_PRIMARY_ID}" = "${STATE_PRIMARY_ID}" ]; then
      :
    else
      fail 'The confirmed physical identity does not match exported state; no state was changed.'
    fi
  else
    fail 'The primary state record has an unsupported or cross-provider type; no state was changed.'
  fi

  choose_action

  if [ "${KEY_COUNT}" = 1 ]; then
    if "${SST_BIN}" state remove "${KEY_NAME}" --stage "${STAGE}" > /dev/null 2> "${ERROR_FILE}"; then
      KEY_DETACHED=true
    else
      fail 'The registration-key state record could not be removed; the primary was not attempted.'
    fi
  else
    KEY_DETACHED=false
  fi

  if "${SST_BIN}" state remove "${PRIMARY_NAME}" --stage "${STAGE}" > /dev/null 2> "${ERROR_FILE}"; then
    :
  elif [ "${KEY_DETACHED}" = true ]; then
    report_partial_completion
  else
    fail 'The primary state record could not be removed and remains managed; do not continue.'
  fi
fi

if capture_final_diff; then
  :
else
  fail 'SST diff failed after cleanup; no apply should be run.'
fi

if grep -Fq -e HetznerDevBox -e HetznerDevBoxTailnetRegistrationAuthKey \
  -e OvhDevBox -e OvhDevBoxTailnetRegistrationAuthKey "${DIFF_FILE}"; then
  fail 'Final SST diff still includes a historical dev-box resource; do not apply it.'
else
  printf '%s\n' 'Cleanup completed and the final SST diff excludes all historical dev-box resources.'
fi
