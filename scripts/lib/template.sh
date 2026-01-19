# shellcheck shell=sh

apply_template_filter_to_value() {
  apply_template_filter_to_value_filter_name="$1"
  apply_template_filter_to_value_value="$2"

  case "${apply_template_filter_to_value_filter_name}" in
    base64) printf '%s' "${apply_template_filter_to_value_value}" | base64 ;;
    *)
      printf "%bError:%b Unknown template filter: %s\n" "${RED}" "${NORMAL}" "${apply_template_filter_to_value_filter_name}" >&2
      return 1
      ;;
  esac
}
