# shellcheck shell=sh

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
