# shellcheck shell=sh

# NOTE: hides typed input, trims whitespace, skips blank lines on a TTY, and prints on stdout
prompt_secret() {
  prompt_secret_label=$1
  prompt_secret_value=''

  if [ -t 0 ]; then
    stty -echo
  fi
  printf '%s' "${prompt_secret_label}" >&2
  while IFS= read -r prompt_secret_line; do
    prompt_secret_value=$(printf '%s' "${prompt_secret_line}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -n "${prompt_secret_value}" ] || [ ! -t 0 ]; then
      break
    fi
  done
  if [ -t 0 ]; then
    stty echo
    printf '\n' >&2
  fi
  printf '%s\n' "${prompt_secret_value}"
}
