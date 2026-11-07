#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

artifacts=$1
built_images=" $2 "
built_charts=" $3 "
current=$(git ls-remote origin refs/heads/main | cut -f1)
[ "$current" = "$SOURCE_REVISION" ] || {
  echo 'A newer main revision exists; skipping this build.'
  exit 0
}
target=deploy/production

previous=$(git ls-remote origin "refs/heads/$target" | cut -f1)
parents=()
if [ -n "$previous" ]; then
  git fetch origin "$previous"
  parents=(-p "$previous")
fi

# Images and charts this run didn't build keep the previous release's pins.
pins=()
for name in $(yq '.images[].name' k3s/components/images/kustomization.yaml); do
  image=${name##*/}
  if [[ $built_images == *" $image "* ]]; then
    pins+=("$(cat "$artifacts/$image.txt")")
  elif [ -n "$previous" ]; then
    pins+=("$name@$(git show "$previous:k3s/components/images/kustomization.yaml" | NAME=$name yq '.images[] | select(.name == strenv(NAME)) | .digest')")
  else
    echo "$image was neither built nor pinned by a previous release; rerun all jobs." >&2
    exit 1
  fi
done
if printf '%s\n' "${pins[@]}" | grep -Evq '^ghcr.io/[^ /]+/[^ /@]+@sha256:[a-f0-9]{64}$'; then
  echo 'Invalid image digest.' >&2
  exit 1
fi
(cd k3s/components/images && kustomize edit set image "${pins[@]}")

for chart in postgres valkey clickhouse; do
  if [[ $built_charts == *" $chart "* ]]; then
    version=$(cat "$artifacts/$chart.version")
    [ "$version" = "$CHART_VERSION" ] || {
      echo "Chart $chart version mismatch; rerun all jobs." >&2
      exit 1
    }
  elif [ -n "$previous" ]; then
    version=$(git show "$previous:packages/$chart/chart/Chart.yaml" | yq .version)
  else
    echo "Chart $chart was neither built nor pinned by a previous release; rerun all jobs." >&2
    exit 1
  fi
  export CHART_REF="oci://ghcr.io/pandoks/charts/$chart" VERSION="$version"
  yq -i '.version = strenv(VERSION)' "packages/$chart/chart/Chart.yaml"
  find apps k3s -name '*.yaml' -exec grep -l "chart: $CHART_REF\$" {} + | while IFS= read -r manifest; do
    yq -i '(select(.kind == "HelmChart" and .spec.chart == strenv(CHART_REF)) | .spec.version) = strenv(VERSION)' "$manifest"
  done
done
printf '%s\n' "$SOURCE_REVISION" > SOURCE_REVISION

git config user.name github-actions[bot]
git config user.email 41898282+github-actions[bot]@users.noreply.github.com
git add k3s apps packages/*/chart/Chart.yaml SOURCE_REVISION
release=$(git commit-tree "$(git write-tree)" "${parents[@]}" -m "Deploy $SOURCE_REVISION")
git push --force-with-lease="refs/heads/$target:$previous" origin "$release:refs/heads/$target"
printf 'revision=%s\n' "$release" >> "$GITHUB_OUTPUT"
printf 'Argo CD release: %s at %s (source %s).\n' "$target" "$release" "$SOURCE_REVISION" >> "$GITHUB_STEP_SUMMARY"
