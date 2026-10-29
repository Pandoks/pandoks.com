#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

artifacts=$1
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
  [ "$(cat "$artifacts/$chart.version")" = "$CHART_VERSION" ] || {
    echo "Chart $chart version mismatch; rerun all jobs." >&2
    exit 1
  }
  yq -i '.version = strenv(CHART_VERSION)' "packages/$chart/chart/Chart.yaml"
done
find apps k3s -name '*.yaml' -exec grep -l 'chart: oci://ghcr.io/pandoks/charts/' {} + | while IFS= read -r manifest; do
  yq -i '(select(.kind == "HelmChart") | .spec.version) = strenv(CHART_VERSION)' "$manifest"
done
if [ -n "$PREVIEW_NUMBER" ]; then
  export PREVIEW_NAMESPACE="preview-$PREVIEW_NUMBER"
  yq -i '.namespace = strenv(PREVIEW_NAMESPACE)' k3s/overlays/preview/kustomization.yaml
fi
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

if [ -n "$PREVIEW_NUMBER" ] && { [ -z "$(git ls-remote origin refs/heads/deploy/dev)" ] \
  || ! git diff --quiet "$BASE_REVISION...$SOURCE_REVISION" -- \
    k3s/bootstrap k3s/base/core k3s/base/monitoring k3s/base/image-fields.yaml \
    k3s/overlays/cluster k3s/overlays/dev k3s/components/images infra scripts/cluster scripts/lib packages/argocd \
    sst.config.ts mise.toml package.json pnpm-lock.yaml pnpm-workspace.yaml ':(exclude)k3s/bootstrap/local'; }; then
  printf 'infrastructure=true\n' >> "$GITHUB_OUTPUT"
fi
