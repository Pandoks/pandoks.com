# shellcheck shell=sh

get_sst_secrets() {
  # NOTE: sst shell automatically sets the directory to the project root unless you are in a
  # subdirectory that is a pnpm workspace.
  get_sst_secrets_json="$(
    pnpm sst shell node scripts/lib/sst-resources.js \
      | jq 'to_entries
            | map(select(.value.type == "sst.sst.Secret"))
            | map({key: .key, value: .value.value})
            | from_entries'
  )"

  printf '%s\n' "${get_sst_secrets_json}"
}
