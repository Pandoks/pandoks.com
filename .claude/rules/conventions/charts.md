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
- **Dev images** are tagged `localhost:12345/<name>:latest`, built +
  pushed by per-package `docker:build` / `dev:push` scripts (e.g.
  `packages/postgres/package.json:13-15`,
  `packages/argocd/package.json:8-9`) via `pnpm -r --if-present dev:push`.
  `localhost:12345` is the **host-side** push port of the k3d registry
  (`scripts/cluster/k3d.sh:64` — `--registry-create local-registry:12345`);
  **inside the cluster** the same registry is reached as
  `local-registry:5000`.
- **`${ImageRegistry}` / `${ImageTag}` resolve per DEPLOY ENV, not
  per local-vs-remote** (`scripts/cluster/deploy.sh:26-46`):
  - `env=local` → registry `local-registry:5000`, tag `latest`. The
    in-cluster k3d registry — **the ONLY env that pulls from k3d.**
  - `env=dev` → registry `ghcr.io/pandoks`, tag = branch name (or
    `latest` on `main`/`master`). **Dev cluster deploys pull from
    ghcr, NOT the local k3d registry** — `dev:push` to `localhost:12345`
    only feeds `deploy local`.
  - `env=prod` → registry `ghcr.io/pandoks`, tag `latest`.
- **Prod images**: `ghcr.io/pandoks/<name>:latest`. Package images are
  injected through the `${ImageRegistry}/<name>:${ImageTag}` template
  vars above, so they DO resolve to `:latest` in prod — the Renovate
  "never `:latest`" rule (`k3s.md`) governs a different surface:
  **hand-written `image:` lines in `apps/**/kube/**` app manifests**,
  not these templated package images. The CI image matrix
  is **8 images** (patroni, pgbackrest, valkey, valkey-reconciler,
  argocd-sst-plugin, clickhouse, clickhouse-keeper, clickhouse-backup) —
  more than the 4 paths-filter trigger roots. **`argocd`'s dev tag is
  `argocd` but its ghcr/CI image name is `argocd-sst-plugin`** (the only
  package where dev tag ≠ ghcr name).
- **Helm OCI charts**: `oci://ghcr.io/<owner>/charts/<name>`
  (`.github/workflows/build-and-publish.yaml:265` — `helm push … oci://…`).
- **Dockerfile build context is repo root** for every package.
  `.github/workflows/build-and-publish.yaml:185` sets `context: .` with the
  warning `# WARN: all dockerfiles should have a context of the root of
the repo`. Dockerfiles reach into `../../...` paths. Confirmed at
  `packages/argocd/Dockerfile:35` (`COPY
packages/argocd/argocd-plugin.yaml ...`).
- **k3d API port is 6444**, not 6443 (`scripts/cluster/k3d.sh:65`), to
  avoid conflicting with the remote prod cluster's port over SSH.
