# shellcheck shell=sh

wait_for_crd() {
  wait_for_crd_name="$1"
  wait_for_crd_timeout="${2:-120}"

  while ! kubectl get crd "${wait_for_crd_name}" > /dev/null 2>&1; do
    if [ "${wait_for_crd_timeout}" -le 0 ]; then
      die "Timed out waiting for ${wait_for_crd_name}"
    fi
    sleep 2
    wait_for_crd_timeout=$((wait_for_crd_timeout - 2))
  done
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
