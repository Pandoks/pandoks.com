# shellcheck shell=sh

get_sst_resources() {
  get_sst_resources_stage="${1:-}"

  # SST changes to the project root unless invoked from a pnpm workspace.
  if [ -n "${get_sst_resources_stage}" ]; then
    pnpm sst shell --stage "${get_sst_resources_stage}" node scripts/lib/sst-resources.ts
  else
    pnpm sst shell node scripts/lib/sst-resources.ts
  fi
}
