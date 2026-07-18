#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
VALIDATOR="${SCRIPT_DIR}/validate-topology-env.sh"

expect_failure() {
  if "$@" > /dev/null 2>&1; then
    printf 'expected failure: %s\n' "$*" >&2
    exit 1
  fi
}

run_validator() {
  env -i \
    PATH="${PATH}" \
    OVH_CLOUD_CONTROL_PLANE_COUNT="${OVH_CLOUD_CONTROL_PLANE_COUNT-}" \
    OVH_CLOUD_WORKER_COUNT="${OVH_CLOUD_WORKER_COUNT-}" \
    OVH_DEDICATED_CONTROL_PLANE_COUNT="${OVH_DEDICATED_CONTROL_PLANE_COUNT-}" \
    OVH_DEDICATED_WORKER_COUNT="${OVH_DEDICATED_WORKER_COUNT-}" \
    OVH_DEDICATED_SERVER_PLAN="${OVH_DEDICATED_SERVER_PLAN-}" \
    OVH_DEDICATED_DATACENTER="${OVH_DEDICATED_DATACENTER-}" \
    OVH_DEDICATED_ORDER_REGION="${OVH_DEDICATED_ORDER_REGION-}" \
    OVH_DEDICATED_PLAN_OPTIONS="${OVH_DEDICATED_PLAN_OPTIONS-}" \
    sh "${VALIDATOR}"
}

expect_failure run_validator

OVH_CLOUD_CONTROL_PLANE_COUNT=one
OVH_CLOUD_WORKER_COUNT=0
OVH_DEDICATED_CONTROL_PLANE_COUNT=0
OVH_DEDICATED_WORKER_COUNT=0
expect_failure run_validator

OVH_CLOUD_CONTROL_PLANE_COUNT=1
OVH_CLOUD_WORKER_COUNT=0
OVH_DEDICATED_CONTROL_PLANE_COUNT=0
OVH_DEDICATED_WORKER_COUNT=0
run_validator

OVH_CLOUD_CONTROL_PLANE_COUNT=41
expect_failure run_validator
OVH_CLOUD_CONTROL_PLANE_COUNT=1

OVH_DEDICATED_CONTROL_PLANE_COUNT=1
expect_failure run_validator

OVH_DEDICATED_SERVER_PLAN=server-plan
OVH_DEDICATED_DATACENTER=bhs
OVH_DEDICATED_ORDER_REGION=canada
OVH_DEDICATED_PLAN_OPTIONS=not-json
expect_failure run_validator

OVH_DEDICATED_PLAN_OPTIONS='[{"duration":"P1M","planCode":"ram","pricingMode":"default","quantity":0}]'
expect_failure run_validator

OVH_DEDICATED_PLAN_OPTIONS='[{"duration":"P1M","planCode":"ram","pricingMode":"default","quantity":1}]'
run_validator

printf '%s\n' 'PASS: topology environment validation fails closed'
