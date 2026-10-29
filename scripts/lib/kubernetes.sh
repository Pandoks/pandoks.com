# shellcheck shell=sh

wait_for_crd() {
  wait_for_crd_name="$1"
  wait_for_crd_timeout="${2:-120}"

  kubectl wait --for=create --for=condition=Established "crd/${wait_for_crd_name}" \
    --timeout="${wait_for_crd_timeout}s" > /dev/null \
    || die "Timed out waiting for ${wait_for_crd_name} to be Established"
}

wait_for_rollout() {
  wait_for_rollout_namespace="$1"
  wait_for_rollout_deployment="$2"
  wait_for_rollout_timeout="$3"

  kubectl -n "${wait_for_rollout_namespace}" wait --for=create "deploy/${wait_for_rollout_deployment}" \
    --timeout="${wait_for_rollout_timeout}s" > /dev/null \
    || die "Timed out waiting for deployment ${wait_for_rollout_namespace}/${wait_for_rollout_deployment} to be created"
  kubectl -n "${wait_for_rollout_namespace}" rollout status "deploy/${wait_for_rollout_deployment}" \
    --timeout="${wait_for_rollout_timeout}s" \
    || die "Timed out waiting for deployment ${wait_for_rollout_namespace}/${wait_for_rollout_deployment} to roll out"
}

validate_and_get_absolute_kubeconfig_path() {
  validate_and_get_absolute_kubeconfig_path_file="$1"

  [ -f "${validate_and_get_absolute_kubeconfig_path_file}" ] \
    || die "kubeconfig not found: ${validate_and_get_absolute_kubeconfig_path_file}"

  validate_and_get_absolute_kubeconfig_path_dir="$(cd "$(dirname "${validate_and_get_absolute_kubeconfig_path_file}")" && pwd)"
  printf "%s/%s" \
    "${validate_and_get_absolute_kubeconfig_path_dir}" \
    "$(basename "${validate_and_get_absolute_kubeconfig_path_file}")"
}
