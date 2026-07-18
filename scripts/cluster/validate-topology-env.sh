#!/bin/sh

set -eu

validate_count() {
  validate_count_name="$1"
  validate_count_value="$2"
  validate_count_max="$3"

  case "${validate_count_value}" in
    '' | *[!0-9]*)
      printf '%s must be a non-negative integer\n' "${validate_count_name}" >&2
      return 1
      ;;
  esac
  if ! [ "${validate_count_value}" -le "${validate_count_max}" ] 2> /dev/null; then
    printf '%s must be between 0 and %s\n' "${validate_count_name}" "${validate_count_max}" >&2
    return 1
  fi
}

require_value() {
  if [ -z "$2" ]; then
    printf '%s is required when dedicated capacity is enabled\n' "$1" >&2
    return 1
  fi
}

validate_count OVH_CLOUD_CONTROL_PLANE_COUNT "${OVH_CLOUD_CONTROL_PLANE_COUNT-}" 40
validate_count OVH_CLOUD_WORKER_COUNT "${OVH_CLOUD_WORKER_COUNT-}" 50
validate_count OVH_DEDICATED_CONTROL_PLANE_COUNT "${OVH_DEDICATED_CONTROL_PLANE_COUNT-}" 50
validate_count OVH_DEDICATED_WORKER_COUNT "${OVH_DEDICATED_WORKER_COUNT-}" 55

if [ "${OVH_DEDICATED_CONTROL_PLANE_COUNT}" -gt 0 ] \
  || [ "${OVH_DEDICATED_WORKER_COUNT}" -gt 0 ]; then
  require_value OVH_DEDICATED_SERVER_PLAN "${OVH_DEDICATED_SERVER_PLAN-}"
  require_value OVH_DEDICATED_DATACENTER "${OVH_DEDICATED_DATACENTER-}"
  require_value OVH_DEDICATED_ORDER_REGION "${OVH_DEDICATED_ORDER_REGION-}"
  require_value OVH_DEDICATED_PLAN_OPTIONS "${OVH_DEDICATED_PLAN_OPTIONS-}"

  if ! command -v jq > /dev/null 2>&1; then
    printf '%s\n' 'jq is required to validate OVH_DEDICATED_PLAN_OPTIONS' >&2
    exit 1
  fi
  if ! printf '%s' "${OVH_DEDICATED_PLAN_OPTIONS}" | jq -e '
    type == "array"
    and all(.[];
      type == "object"
      and (.duration | type == "string")
      and (.planCode | type == "string")
      and (.pricingMode | type == "string")
      and (
        .quantity
        | type == "number"
        and floor == .
        and . >= 1
      )
    )
  ' > /dev/null; then
    printf '%s\n' 'OVH_DEDICATED_PLAN_OPTIONS must be a valid dedicated-plan JSON array' >&2
    exit 1
  fi
fi
