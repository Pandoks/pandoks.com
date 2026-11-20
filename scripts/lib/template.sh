# shellcheck shell=sh

# Substitute ${VAR} patterns in input with values from JSON
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

    template_substitute_var=$(printf '%s' "${template_substitute_pattern_content}" | tr -d ' ')

    template_substitute_result=$(printf '%s' "${template_substitute_json}" | jq -r --arg k "${template_substitute_var}" '.[$k] // empty')
    [ -z "${template_substitute_result}" ] && continue

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
