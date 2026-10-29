#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

artifacts=$1
current=$(git ls-remote origin refs/heads/main | cut -f1)
[ "$current" = "$SOURCE_REVISION" ] || {
  echo 'A newer main revision exists; skipping this build.'
  exit 0
}
target=deploy/production

mapfile -t images < <(cat "$artifacts/"*.txt)
expected=$(yq '.images[].name' k3s/components/images/kustomization.yaml | sort)
actual=$(printf '%s\n' "${images[@]}" | cut -d@ -f1 | sort)
[ "$actual" = "$expected" ] || {
  echo 'Incomplete image outputs; rerun all jobs.' >&2
  exit 1
}
if printf '%s\n' "${images[@]}" | grep -Evq '^ghcr.io/[^ /]+/[^ /@]+@sha256:[a-f0-9]{64}$'; then
  echo 'Invalid image digest.' >&2
  exit 1
fi
(cd k3s/components/images && kustomize edit set image "${images[@]}")

for chart in postgres valkey clickhouse; do
  [ "$(cat "$artifacts/$chart.version")" = "$CHART_VERSION" ]
  yq -i '.version = strenv(CHART_VERSION)' "packages/$chart/chart/Chart.yaml"
done
find apps k3s -name '*.yaml' -exec grep -l 'chart: oci://ghcr.io/pandoks/charts/' {} + | while IFS= read -r manifest; do
  yq -i '(select(.kind == "HelmChart") | .spec.version) = strenv(CHART_VERSION)' "$manifest"
done
printf '%s\n' "$SOURCE_REVISION" > SOURCE_REVISION

previous=$(git ls-remote origin "refs/heads/$target" | cut -f1)
parents=()
if [ -n "$previous" ]; then
  git fetch origin "$previous"
  parents=(-p "$previous")
fi
git config user.name github-actions[bot]
git config user.email 41898282+github-actions[bot]@users.noreply.github.com
git add k3s apps packages/*/chart/Chart.yaml SOURCE_REVISION
release=$(git commit-tree "$(git write-tree)" "${parents[@]}" -m "Deploy $SOURCE_REVISION")
git push --force-with-lease="refs/heads/$target:$previous" origin "$release:refs/heads/$target"
printf 'revision=%s\n' "$release" >> "$GITHUB_OUTPUT"
printf 'Argo CD release: %s at %s (source %s).\n' "$target" "$release" "$SOURCE_REVISION" >> "$GITHUB_STEP_SUMMARY"
