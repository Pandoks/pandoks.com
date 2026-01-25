# shellcheck shell=sh

yaml_safe_value() {
  yaml_safe_value_input="$1"
  yaml_safe_value_escaped=$(printf '%s' "${yaml_safe_value_input}" | sed "s/'/''/g")
  printf "'%s'" "${yaml_safe_value_escaped}"
}

apply_template_filter_to_value() {
  apply_template_filter_to_value_filter_name="$1"
  apply_template_filter_to_value_value="$2"

  # shellcheck disable=SC2016
  case "${apply_template_filter_to_value_filter_name}" in
    base64) printf '%s' "${apply_template_filter_to_value_value}" | base64 -w0 ;;
    bcrypt) htpasswd -nbBC 10 "" "${apply_template_filter_to_value_value}" | tr -d ':\n' | sed 's/$2y/$2a/' ;;
    quote) yaml_safe_value "${apply_template_filter_to_value_value}" ;;
    *)
      printf "%bError:%b Unknown template filter: %s\n" "${RED}" "${NORMAL}" "${apply_template_filter_to_value_filter_name}" >&2
      return 1
      ;;
  esac
}

# Substitute ${VAR} and ${VAR | filter} patterns in input with values from JSON
# If a variable doesn't exist in JSON, the pattern is left as-is
# Arguments:
#   $1 - Input string with template variables
#   $2 - JSON object with key-value pairs for substitution
# Returns:
#   Substituted string via stdout
template_substitute() {
  template_substitute_template="$1"
  template_substitute_json="$2"
  template_substitute_output="${template_substitute_template}"

  # Find all ${...} patterns
  template_substitute_patterns=$(printf '%s' "${template_substitute_template}" | grep -oE '\$\{[^}]+\}' | sort -u)

  while IFS= read -r template_substitute_pattern; do
    [ -z "${template_substitute_pattern}" ] && continue

    template_substitute_pattern_content="${template_substitute_pattern#\$\{}"
    template_substitute_pattern_content="${template_substitute_pattern_content%\}}"

    case "${template_substitute_pattern_content}" in
      *"|"*)
        template_substitute_var="${template_substitute_pattern_content%%|*}"
        template_substitute_var=$(printf '%s' "${template_substitute_var}" | tr -d ' ')

        template_substitute_result=$(printf '%s' "${template_substitute_json}" | jq -r --arg k "${template_substitute_var}" '.[$k] // empty')
        [ -z "${template_substitute_result}" ] && continue

        template_substitute_filters="${template_substitute_pattern_content#*|}"
        while [ -n "${template_substitute_filters}" ]; do
          case "${template_substitute_filters}" in
            *"|"*)
              template_substitute_filter="${template_substitute_filters%%|*}"
              template_substitute_filters="${template_substitute_filters#*|}"
              ;;
            *)
              template_substitute_filter="${template_substitute_filters}"
              template_substitute_filters=""
              ;;
          esac
          template_substitute_filter=$(printf '%s' "${template_substitute_filter}" | tr -d ' ')
          template_substitute_result=$(apply_template_filter_to_value "${template_substitute_filter}" "${template_substitute_result}") || return 1
        done
        ;;
      *)
        template_substitute_var=$(printf '%s' "${template_substitute_pattern_content}" | tr -d ' ')

        template_substitute_result=$(printf '%s' "${template_substitute_json}" | jq -r --arg k "${template_substitute_var}" '.[$k] // empty')
        [ -z "${template_substitute_result}" ] && continue
        ;;
    esac

    template_substitute_output=$(printf '%s' "${template_substitute_output}" | awk -v pat="${template_substitute_pattern}" -v rep="${template_substitute_result}" '{
      while ((idx = index($0, pat)) > 0) {
        $0 = substr($0, 1, idx-1) rep substr($0, idx+length(pat))
      }
      print
    }')
  done << EOF
${template_substitute_patterns}
EOF

  printf '%s' "${template_substitute_output}"
}
