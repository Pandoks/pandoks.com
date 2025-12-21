# shellcheck shell=sh

get_sst_secrets() {
  # NOTE: sst shell automatically sets the directory to the project root unless you are in a
  # subdirectory that is a pnpm workspace.
  get_sst_secrets_json="$(pnpm sst shell node scripts/lib/secrets.js)"
  printf '%s\n' "${get_sst_secrets_json}"
}
