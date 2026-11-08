#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

artifacts=$1
built_images=" $2 "
built_charts=" $3 "
production_release=$4
if [ -n "$PREVIEW_NUMBER" ]; then
  current=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PREVIEW_NUMBER")
  if ! jq -e --arg source "$SOURCE_REVISION" --arg repo "$GITHUB_REPOSITORY" \
    '.state == "open" and .head.sha == $source and .head.repo.full_name == $repo and any(.labels[]; .name == "preview")' <<< "$current" > /dev/null; then
    echo 'Preview was closed, changed, or opted out; skipping this build.'
    exit 0
  fi
  target="deploy/preview-$PREVIEW_NUMBER"
else
  current=$(git ls-remote origin refs/heads/main | cut -f1)
  [ "$current" = "$SOURCE_REVISION" ] || {
    echo 'A newer main revision exists; skipping this build.'
    exit 0
  }
  target=deploy/production
fi

previous=$(git ls-remote origin "refs/heads/$target" | cut -f1)
parents=()
if [ -n "$previous" ]; then
  git fetch origin "$previous"
  parents=(-p "$previous")
fi
[ -z "$production_release" ] || git fetch origin "$production_release"

# Images and charts this run didn't build keep the pins of the production release it detected changes against.
pins=()
for name in $(yq '.images[].name' k3s/components/images/kustomization.yaml); do
  image=${name##*/}
  if [[ $built_images == *" $image "* ]]; then
    pins+=("$(cat "$artifacts/$image.txt")")
  elif [ -n "$production_release" ]; then
    pins+=("$name@$(git show "$production_release:k3s/components/images/kustomization.yaml" | NAME=$name yq '.images[] | select(.name == strenv(NAME)) | .digest')")
  else
    echo "$image was neither built nor pinned by a production release; rerun all jobs." >&2
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
  elif [ -n "$production_release" ]; then
    version=$(git show "$production_release:packages/$chart/chart/Chart.yaml" | yq .version)
  else
    echo "Chart $chart was neither built nor pinned by a production release; rerun all jobs." >&2
    exit 1
  fi
  export CHART_REF="oci://ghcr.io/pandoks/charts/$chart" VERSION="$version"
  yq -i '.version = strenv(VERSION)' "packages/$chart/chart/Chart.yaml"
  find apps k3s -name '*.yaml' -exec grep -l "chart: $CHART_REF\$" {} + | while IFS= read -r manifest; do
    yq -i '(select(.kind == "HelmChart" and .spec.chart == strenv(CHART_REF)) | .spec.version) = strenv(VERSION)' "$manifest"
  done
done
if [ -n "$PREVIEW_NUMBER" ]; then
  export PREVIEW_NAMESPACE="preview-$PREVIEW_NUMBER"
  yq -i '.namespace = strenv(PREVIEW_NAMESPACE)' k3s/overlays/preview/kustomization.yaml
fi
printf '%s\n' "$SOURCE_REVISION" > SOURCE_REVISION

git config user.name github-actions[bot]
git config user.email 41898282+github-actions[bot]@users.noreply.github.com
git add k3s apps packages/*/chart/Chart.yaml SOURCE_REVISION
release=$(git commit-tree "$(git write-tree)" "${parents[@]}" -m "Deploy $SOURCE_REVISION")
git push --force-with-lease="refs/heads/$target:$previous" origin "$release:refs/heads/$target"
printf 'revision=%s\n' "$release" >> "$GITHUB_OUTPUT"
printf 'Argo CD release: %s at %s (source %s).\n' "$target" "$release" "$SOURCE_REVISION" >> "$GITHUB_STEP_SUMMARY"

if [ -n "$PREVIEW_NUMBER" ] && { [ -z "$(git ls-remote origin refs/heads/deploy/dev)" ] \
  || ! git diff --quiet "$BASE_REVISION...$SOURCE_REVISION" -- \
    k3s/bootstrap k3s/base/core k3s/base/monitoring k3s/base/image-fields.yaml \
    k3s/overlays/cluster k3s/overlays/dev k3s/components/images infra scripts/cluster scripts/lib packages/argocd \
    sst.config.ts mise.toml package.json pnpm-lock.yaml pnpm-workspace.yaml ':(exclude)k3s/bootstrap/local'; }; then
  printf 'infrastructure=true\n' >> "$GITHUB_OUTPUT"
fi
