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
      echo "Timed out waiting for ${wait_for_crd_name}" >&2
      exit 1
    fi
    sleep 2
    wait_for_crd_timeout=$((wait_for_crd_timeout - 2))
  done
}
