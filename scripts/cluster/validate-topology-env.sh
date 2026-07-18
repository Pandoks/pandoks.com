#!/bin/sh

set -eu

CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY=25
CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP=1
CLUSTER_NETWORK_DHCP_CONSUMERS=2
DHCP_ALLOCATION_CAPACITY=98

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

TOTAL_CONTROL_PLANES=$((\
  OVH_CLOUD_CONTROL_PLANE_COUNT + OVH_DEDICATED_CONTROL_PLANE_COUNT))
PUBLIC_CLOUD_FIXED_IPS=$((\
  OVH_CLOUD_CONTROL_PLANE_COUNT + OVH_CLOUD_WORKER_COUNT))
TOTAL_INGRESS_NODES=$((\
  OVH_CLOUD_CONTROL_PLANE_COUNT + \
  OVH_CLOUD_WORKER_COUNT + \
  OVH_DEDICATED_CONTROL_PLANE_COUNT + \
  OVH_DEDICATED_WORKER_COUNT))
PRIVATE_API_VIPS=0
if [ "${TOTAL_CONTROL_PLANES}" -gt 0 ]; then
  PRIVATE_API_VIPS=1
fi
INGRESS_GROUPS=$(((\
  TOTAL_INGRESS_NODES + \
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY - \
  1) / \
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY))
PUBLIC_INGRESS_VIPS=$((INGRESS_GROUPS * CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP))
DHCP_ALLOCATION_DEMAND=$((\
  PUBLIC_CLOUD_FIXED_IPS + \
  CLUSTER_NETWORK_DHCP_CONSUMERS + \
  PRIVATE_API_VIPS + \
  PUBLIC_INGRESS_VIPS))
if [ "${DHCP_ALLOCATION_DEMAND}" -gt "${DHCP_ALLOCATION_CAPACITY}" ]; then
  printf 'Cluster topology requires %s DHCP allocations but only %s are available\n' \
    "${DHCP_ALLOCATION_DEMAND}" "${DHCP_ALLOCATION_CAPACITY}" >&2
  exit 1
fi
if [ "${TOTAL_CONTROL_PLANES}" -gt "${CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY}" ]; then
  printf 'The single private API load balancer supports at most %s control-plane members\n' \
    "${CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY}" >&2
  exit 1
fi

if [ "${OVH_DEDICATED_CONTROL_PLANE_COUNT}" -gt 0 ] \
  || [ "${OVH_DEDICATED_WORKER_COUNT}" -gt 0 ]; then
  require_value OVH_DEDICATED_SERVER_PLAN "${OVH_DEDICATED_SERVER_PLAN-}"
  require_value OVH_DEDICATED_DATACENTER "${OVH_DEDICATED_DATACENTER-}"
  require_value OVH_DEDICATED_ORDER_REGION "${OVH_DEDICATED_ORDER_REGION-}"
  require_value OVH_DEDICATED_PLAN_OPTIONS "${OVH_DEDICATED_PLAN_OPTIONS-}"
fi

if [ -n "${OVH_DEDICATED_PLAN_OPTIONS-}" ]; then
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

# This is deliberately opt-in and reports only derived, non-secret capacity
# data so the TypeScript topology contract tests can exercise the same POSIX
# arithmetic as CI. It does not bypass any validation above.
if [ "${OVH_TOPOLOGY_VALIDATOR_REPORT-}" = 1 ]; then
  printf 'dhcp-allocation-demand=%s\n' "${DHCP_ALLOCATION_DEMAND}"
fi
