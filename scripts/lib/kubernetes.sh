# shellcheck shell=sh

#######################################
# Wait for a CRD to be established.
# Arguments:
#   CRD name
#   Timeout in seconds (default: 120)
# Returns:
#   0 on success, exits with 1 on timeout
#######################################
wait_for_crd() {
  wait_for_crd_name="$1"
  wait_for_crd_timeout="${2:-120}"

  while ! kubectl get crd "${wait_for_crd_name}" > /dev/null 2>&1; do
    if [ "${wait_for_crd_timeout}" -le 0 ]; then
      if [ -n "${RED:-}" ]; then
        printf "%bError:%b Timed out waiting for %s\n" "${RED}" "${NORMAL}" "${wait_for_crd_name}" >&2
      else
        echo "Error: Timed out waiting for ${wait_for_crd_name}" >&2
      fi
      exit 1
    fi
    sleep 2
    wait_for_crd_timeout=$((wait_for_crd_timeout - 2))
  done
}

#######################################
# Validate kubeconfig file and return absolute path.
# Arguments:
#   Path to kubeconfig file
# Outputs:
#   Absolute path to kubeconfig file to stdout
# Returns:
#   0 on success, exits with 1 on failure
#######################################
validate_and_get_absolute_kubeconfig_path() {
  validate_and_get_absolute_kubeconfig_path_file="$1"

  if [ ! -f "${validate_and_get_absolute_kubeconfig_path_file}" ]; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b kubeconfig not found: %s\n" "${RED}" "${NORMAL}" "${validate_and_get_absolute_kubeconfig_path_file}" >&2
    else
      echo "Error: kubeconfig not found: ${validate_and_get_absolute_kubeconfig_path_file}" >&2
    fi
    exit 1
  fi

  validate_and_get_absolute_kubeconfig_path_absolute_dir="$(cd "$(dirname "${validate_and_get_absolute_kubeconfig_path_file}")" && pwd)"
  validate_and_get_absolute_kubeconfig_path_base_name="$(basename "${validate_and_get_absolute_kubeconfig_path_file}")"
  printf "%s" "${validate_and_get_absolute_kubeconfig_path_absolute_dir}/${validate_and_get_absolute_kubeconfig_path_base_name}"
}

get_k3d_ip_pool() {
  get_k3d_ip_pool_network_name="${1:-k3d-local-cluster}"

  if ! docker network inspect "${get_k3d_ip_pool_network_name}" > /dev/null 2>&1; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b --k3d specified but docker network not found: %s\n" "${RED}" "${NORMAL}" "${get_k3d_ip_pool_network_name}" >&2
    else
      echo "Error: --k3d specified but docker network not found: ${get_k3d_ip_pool_network_name}" >&2
    fi
    echo "Provide an existing network with --network NAME or create the k3d cluster first." >&2
    exit 1
  fi

  get_k3d_ip_pool_subnet=$(docker network inspect "${get_k3d_ip_pool_network_name}" \
    | jq -r '.[0].IPAM.Config[0].Subnet')
  if [ -z "${get_k3d_ip_pool_subnet}" ] || [ "${get_k3d_ip_pool_subnet}" = "null" ]; then
    if [ -n "${RED:-}" ]; then
      printf "%bError:%b Failed to detect subnet from network '%s'. Is the cluster/network running?\n" "${RED}" "${NORMAL}" "${get_k3d_ip_pool_network_name}" >&2
    else
      echo "Error: Failed to detect subnet from network '${get_k3d_ip_pool_network_name}'. Is the cluster/network running?" >&2
    fi
    exit 1
  fi

  printf "%s" "${get_k3d_ip_pool_subnet}"
}
