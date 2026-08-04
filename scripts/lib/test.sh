# shellcheck shell=sh

test_suite() {
  TEST_SUITE_NAME="$1"
  TEST_PASS_COUNT=0
  TEST_CASE_COUNT=0
  trap test_finish EXIT
  printf "%b==>%b %s cluster tests\n" "${BOLD}" "${NORMAL}" "${TEST_SUITE_NAME}"
}

test_case() {
  TEST_CASE_COUNT=$((TEST_CASE_COUNT + 1))
  printf "\n%b[%s %s]%b %s\n" "${BOLD}" "${TEST_SUITE_NAME}" "${TEST_CASE_COUNT}" "${NORMAL}" "$1"
}

test_assert() {
  test_assert_desc="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    TEST_PASS_COUNT=$((TEST_PASS_COUNT + 1))
    log_ok "${test_assert_desc}"
  else
    log_error "FAIL: ${test_assert_desc}"
    printf "  command: %s\n" "$*" >&2
    exit 1
  fi
}

test_assert_eq() {
  test_assert_eq_desc="$1"
  if [ "$2" = "$3" ]; then
    TEST_PASS_COUNT=$((TEST_PASS_COUNT + 1))
    log_ok "${test_assert_eq_desc}"
  else
    log_error "FAIL: ${test_assert_eq_desc}"
    printf "  expected: %s\n  actual:   %s\n" "$2" "$3" >&2
    exit 1
  fi
}

test_assert_ne() {
  test_assert_ne_desc="$1"
  if [ "$2" != "$3" ]; then
    TEST_PASS_COUNT=$((TEST_PASS_COUNT + 1))
    log_ok "${test_assert_ne_desc}"
  else
    log_error "FAIL: ${test_assert_ne_desc}"
    printf "  both values: %s\n" "$2" >&2
    exit 1
  fi
}

# Poll a command every 3s until it succeeds or the timeout (seconds) passes.
test_wait_for() {
  test_wait_for_deadline=$(($(date +%s) + $1))
  test_wait_for_desc="$2"
  shift 2
  until "$@" > /dev/null 2>&1; do
    if [ "$(date +%s)" -gt "${test_wait_for_deadline}" ]; then
      log_error "FAIL: timed out waiting for ${test_wait_for_desc}"
      printf "  command: %s\n" "$*" >&2
      exit 1
    fi
    sleep 3
  done
  TEST_PASS_COUNT=$((TEST_PASS_COUNT + 1))
  log_ok "${test_wait_for_desc}"
}

# One "<name> <uid> <restartCounts>" line per pod, sorted — identical output
# before/after an operation proves zero pod churn.
test_pod_fingerprint() {
  kubectl get pods -n "$1" -l "$2" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.uid}{" "}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' \
    | sort
}

test_delete_namespace() {
  kubectl delete namespace "$1" --ignore-not-found --wait --timeout=300s
}

# EXIT trap installed by test_suite. Suites must define test_cleanup.
# Success: clean up unless TEST_KEEP=1. Failure: always keep for inspection
# (the next run's install-time cleanup removes stale state).
test_finish() {
  test_finish_status=$?
  printf "\n"
  if [ "${test_finish_status}" -eq 0 ]; then
    log_ok "${TEST_SUITE_NAME}: ${TEST_PASS_COUNT} assertions passed"
    if [ "${TEST_KEEP:-0}" = "1" ]; then
      log_warn "--keep: leaving ${TEST_SUITE_NAME} test resources in place"
    else
      test_cleanup
    fi
  else
    log_error "${TEST_SUITE_NAME}: failed after ${TEST_PASS_COUNT} passing assertions"
    log_warn "test resources left in place for inspection"
  fi
  exit "${test_finish_status}"
}
