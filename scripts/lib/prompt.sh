# shellcheck shell=sh

# NOTE: hides typed input and prints the answer on stdout, so callers capture it with $(...)
prompt_secret() {
  prompt_secret_label=$1

  if [ -t 0 ]; then
    stty -echo
  fi
  printf '%s' "${prompt_secret_label}" >&2
  read -r prompt_secret_value
  if [ -t 0 ]; then
    stty echo
    printf '\n' >&2
  fi
  printf '%s\n' "${prompt_secret_value}"
}
