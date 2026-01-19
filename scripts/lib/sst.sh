# shellcheck shell=sh

get_sst_resources_json() {
  get_sst_secrets_stage="${1:-}"

  # NOTE: sst shell automatically sets the directory to the project root unless you are in a
  # subdirectory that is a pnpm workspace.
  if [ -n "${get_sst_secrets_stage}" ]; then
    pnpm sst shell --stage "${get_sst_secrets_stage}" node scripts/lib/sst-resources.js
  else
    pnpm sst shell node scripts/lib/sst-resources.js
  fi
}

extract_sst_resource() {
  extract_sst_resource_json="${1:-}"
  extract_sst_resource_name="${2:-}"

  if [ -z "${extract_sst_resource_json}" ]; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b SST resources JSON is required\n" "${RED}" "${NORMAL}" >&2
    else
      echo "Error: SST resources JSON is required" >&2
    fi
    return 1
  fi

  if [ -z "${extract_sst_resource_name}" ]; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b SST resource name is required\n" "${RED}" "${NORMAL}" >&2
    else
      echo "Error: SST resource name is required" >&2
    fi
    return 1
  fi

  extract_sst_resource_value=$(printf '%s' "${extract_sst_resource_json}" | jq -r --arg name "${extract_sst_resource_name}" '.[$name].value // .[$name].name // empty')

  if [ -z "${extract_sst_resource_value}" ]; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b SST resource not found: %s\n" "${RED}" "${NORMAL}" "${extract_sst_resource_name}" >&2
    else
      echo "Error: SST resource not found: ${extract_sst_resource_name}" >&2
    fi
    return 1
  fi

  printf '%s' "${extract_sst_resource_value}"
}
