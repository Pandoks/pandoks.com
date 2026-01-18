# shellcheck shell=sh

get_sst_secrets() {
  get_sst_secrets_stage="${1:-}"

  # NOTE: sst shell automatically sets the directory to the project root unless you are in a
  # subdirectory that is a pnpm workspace.
  if [ -n "${get_sst_secrets_stage}" ]; then
    pnpm sst shell --stage "${get_sst_secrets_stage}" node scripts/lib/sst-resources.js \
      | jq 'to_entries
            | map(select(.value.type == "sst.sst.Secret"))
            | map({key: .key, value: .value.value})
            | from_entries'
  else
    pnpm sst shell node scripts/lib/sst-resources.js \
      | jq 'to_entries
            | map(select(.value.type == "sst.sst.Secret"))
            | map({key: .key, value: .value.value})
            | from_entries'
  fi
}
