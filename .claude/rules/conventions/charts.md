---
paths:
  - 'packages/**/Dockerfile'
  - 'packages/**/chart/**'
  - 'packages/**/*.yaml'
  - 'k3s/**/*.yaml'
  - '.github/workflows/build-and-publish.yaml'
---

# Code style — Helm / charts / Docker

- **Chart `.tgz` are generated, never committed** (`.gitignore:69` —
  `*.tgz`).
- **Dev images push to `localhost:12345`** (k3d registry,
  `scripts/cluster/k3d.sh:36`); prod images go to
  `ghcr.io/pandoks/<name>:latest`.
- **Helm OCI charts**: `oci://ghcr.io/<owner>/charts/<name>`
  (`.github/workflows/build-and-publish.yaml:186`).
- **Dockerfile build context is repo root** for every package.
  `.github/workflows/build-and-publish.yaml:144` sets `context: .` with the
  warning `# WARN: all dockerfiles should have a context of the root of
the repo`. Dockerfiles reach into `../../...` paths. Confirmed at
  `packages/argocd/Dockerfile:25-26` (`COPY
packages/argocd/argocd-plugin.yaml ...`).
- **k3d API port is 6444**, not 6443 (`scripts/cluster/k3d.sh:37`), to
  avoid conflicting with the remote prod cluster's port over SSH.
