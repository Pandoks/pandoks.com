# shellcheck shell=sh

get_sst_resources() {
  get_sst_resources_stage="${1:-}"

  # NOTE: sst shell automatically sets the directory to the project root unless you are in a
  # subdirectory that is a pnpm workspace.
  if [ -n "${get_sst_resources_stage}" ]; then
    pnpm sst shell --stage "${get_sst_resources_stage}" node scripts/lib/sst-resources.js
  else
    pnpm sst shell node scripts/lib/sst-resources.js
  fi
}
