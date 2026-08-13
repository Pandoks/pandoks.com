#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../.."

. "${REPO_ROOT}/scripts/lib/branch-tag.sh"
. "${REPO_ROOT}/scripts/lib/ghcr.sh"
. "${REPO_ROOT}/scripts/lib/font.sh"
. "${REPO_ROOT}/scripts/lib/log.sh"
. "${SCRIPT_DIR}/deploy.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

sleep() { :; }

add_image_cohort() {
  add_image_cohort_tag="$1"
  for add_image_cohort_image in \
    patroni pgbackrest valkey valkey-reconciler argocd-sst-plugin \
    clickhouse clickhouse-keeper clickhouse-backup; do
    cmd_deploy_image_tags="${cmd_deploy_image_tags}${add_image_cohort_image}	${add_image_cohort_tag}
"
  done
}

manifest_fixture=found
ghcr_manifest_http_status() {
  case "${manifest_fixture}:$2" in
    found:*) printf '200' ;;
    missing:*) printf '404' ;;
    denied:*) printf '401' ;;
    transient:*) printf '503' ;;
    fallback:*"${staging_2}") printf '404' ;;
    fallback:*"${staging_1}") printf '200' ;;
    *) printf '404' ;;
  esac
}

branch=long-branch-long-branch-long-branch-long-branch-long-branch-long-branch-long-branch
key=$(branch_tag "${branch}")
sha=0123456789abcdef0123456789abcdef01234567
attempt_1=$(image_cohort_tag "${key}" "${sha}" 99 1)
attempt_2=$(image_cohort_tag "${key}" "${sha}" 99 2)
staging_1=$(image_cohort_staging_tag "${key}" "${sha}" 99 1)
staging_2=$(image_cohort_staging_tag "${key}" "${sha}" 99 2)
future_bound=$(image_cohort_tag "${key}" "${sha}" 18446744073709551615 9999999999)
marker=$(image_cohort_marker_tag "${future_bound}")
[ "${attempt_1}" != "${attempt_2}" ] || fail "workflow attempts must have distinct tags"
[ "${staging_1}" != "${staging_2}" ] || fail "workflow attempt staging tags must be distinct"
[ "${#staging_2}" -le 128 ] || fail "staging tag exceeds the Docker tag bound"
[ "${#marker}" -le 128 ] || fail "marker exceeds the Docker tag bound"
image_cohort_tag_is_valid_for_key "${key}" "${attempt_1}" \
  || fail "generated cohort tag did not validate"
if image_cohort_staging_tag "${key}" invalid-sha 99 1 > /dev/null 2>&1; then
  fail "invalid staging input was masked as success"
fi

available_staging=""
for image in patroni pgbackrest valkey valkey-reconciler argocd-sst-plugin clickhouse clickhouse-keeper; do
  available_staging="${available_staging}${image} ${staging_1}
"
done
available_staging="${available_staging}clickhouse-backup ${staging_2}
"
for image in \
  patroni pgbackrest valkey valkey-reconciler argocd-sst-plugin \
  clickhouse clickhouse-keeper clickhouse-backup; do
  manifest_fixture=fallback
  ghcr_find_image_staging_tag "pandoks/${image}" "${key}" "${sha}" 99 2 token > /dev/null \
    || fail "failed-job rerun could not reuse the newest successful staging ref for ${image}"
done
staging_2_count=$(printf '%s\n' "${available_staging}" | grep -Fc " ${staging_2}" || true)
if [ "${staging_2_count}" -eq 8 ]; then
  fail "failed-job fixture unexpectedly rebuilt every matrix leg"
fi

manifest_fixture=found
selected_staging=$(ghcr_find_image_staging_tag pandoks/valkey "${key}" "${sha}" 99 2 token)
[ "${selected_staging}" = "${staging_2}" ] || fail "latest staging attempt was not selected"
manifest_fixture=missing
if ghcr_find_image_staging_tag pandoks/valkey "${key}" "${sha}" 99 2 token > /dev/null; then
  fail "missing staging attempts returned success"
fi
manifest_fixture=denied
if ghcr_find_image_staging_tag pandoks/valkey "${key}" "${sha}" 99 2 token > /dev/null 2>&1; then
  fail "authentication failure fell back to an older staging attempt"
fi
manifest_fixture=transient
if ghcr_find_image_staging_tag pandoks/valkey "${key}" "${sha}" 99 2 token > /dev/null 2>&1; then
  fail "transient failure fell back to an older staging attempt"
fi

cmd_deploy_image_tags=""
add_image_cohort "${attempt_1}"
add_image_cohort "${attempt_2}"
if cmd_deploy_find_image_cohort "${key}" > /dev/null; then
  fail "an unmarked cohort was selected"
fi

cmd_deploy_image_tags="valkey	ok-${attempt_1}
valkey	ok-${attempt_2}
"
add_image_cohort "${attempt_1}"
for image in patroni pgbackrest valkey valkey-reconciler; do
  cmd_deploy_image_tags="${cmd_deploy_image_tags}${image}	${attempt_2}
"
done
selected=$(cmd_deploy_find_image_cohort "${key}")
[ "${selected}" = "${attempt_1}" ] || fail "a newer partial attempt displaced a complete cohort"

add_image_cohort "${attempt_2}"
selected=$(cmd_deploy_find_image_cohort "${key}")
[ "${selected}" = "${attempt_2}" ] || fail "the newest complete marked attempt was not selected"

fixture_branch=feature/exact-sha
fixture_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
fixture_old_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
fixture_key=$(branch_tag "${fixture_branch}")
cmd_deploy_image_tags=""
add_image_cohort "ref-${fixture_key}-${fixture_old_sha}"
add_image_cohort "ref-${fixture_key}-${fixture_sha}"
git() {
  if [ "$1" = "ls-remote" ]; then
    printf '%s\trefs/heads/%s\n' "${fixture_sha}" "${fixture_branch}"
  else
    command git "$@"
  fi
}
cmd_deploy_load_image_tags() { :; }
selected=$(cmd_deploy_remote_image_tag "${fixture_branch}" true)
[ "${selected}" = "ref-${fixture_key}-${fixture_sha}" ] \
  || fail "legacy fallback did not select the exact origin branch SHA"

printf 'image cohort tests passed\n'
