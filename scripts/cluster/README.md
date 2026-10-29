# Cluster CLI

This directory contains the shell-based CLI used for managing local k3d clusters,
shared dependencies, and Kubernetes resources. The cluster
scripts use POSIX `sh`.

## Entry Point

```sh
./scripts/cluster/main.sh <command> [subcommand] [options]
```

Use `help`, `--help`, or `-h` with any command/subcommand to view detailed
options. Package scripts in `package.json` are wired directly to
`./scripts/cluster/main.sh`, so you can invoke everything via `pnpm` as well.

## Top-Level Commands

| Command  | Description                                       |
| -------- | ------------------------------------------------- |
| `k3d`    | Manage the local k3d cluster and dependencies.    |
| `deploy` | Deploy environment overlay (local, dev, or prod). |

## k3d Subcommands

```sh
./scripts/cluster/main.sh k3d <subcommand>
```

| Subcommand | Description                                           |
| ---------- | ----------------------------------------------------- |
| `up`       | Create `local-cluster` on pandoks-net.                |
| `down`     | Delete the cluster if it exists.                      |
| `start`    | Start an existing cluster.                            |
| `stop`     | Stop the running cluster.                             |
| `restart`  | Stop and start the cluster sequentially.              |
| `deps`     | Manage Docker Compose dependencies (up/down/restart). |

## deploy

`deploy` applies environment-specific kustomize paths to the cluster:

```sh
./scripts/cluster/main.sh deploy <local|dev|prod> [--bootstrap] [--stage <STAGE>] [--dry-run] [--kubeconfig <PATH>] [--quiet]
```

Deploy uses `k3s/overlays/<env>` by default. On a fresh cluster, run `--bootstrap`
first, then deploy without it. Overlays include bootstrap resources but skip bootstrap waits.

| Environment | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `local`     | Local images/charts; SST's default stage.                         |
| `dev`       | Shared preview infrastructure; SST stage `dev`.                   |
| `preview`   | Argo's render-only target for a prepared PR ref; SST stage `dev`. |
| `prod`      | Production cluster; declared image pins; SST stage `production`.  |

| Option         | Description                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| `--bootstrap`  | Apply bootstrap resources; wait for CRDs and rollouts; unavailable for preview. |
| `--stage`      | Override the SST stage; prod always uses `production`.                          |
| `--dry-run`    | Render YAML; skip confirmation, apply, and waits.                               |
| `--kubeconfig` | Kubeconfig file for kubectl.                                                    |
| `--quiet`/`-q` | Hide info logs and the dry-run heading.                                         |

Options can be combined. `preview` requires `--dry-run` and cannot bootstrap. The selected
kubeconfig/context chooses the actual cluster; manual deploys ask for confirmation.
`--dry-run --quiet` prints only YAML.

Renders need SST and standalone Kustomize; pinned remote resources need network access.
Images are declared in Kustomize; deploy does not build images or query registries.
Bootstrap failures stop the command. Dev/prod also wait for Argo CD and upgrade CRDs.

CI builds images/charts and publishes prepared Git refs; Argo uses this CLI to render them.
Same-repository PRs targeting `main` with the `preview` label deploy automatically to dev; successful `main` builds deploy to production.
Manual commands handle bootstrap and recovery; see [the remote workflow](../../k3s/README.md).

### Template Variables

The `deploy` command renders templates with these substitutions before applying:

| Variable                | Description                          |
| ----------------------- | ------------------------------------ |
| `${<SST Resource>}`     | Exported SST value by resource name. |
| `${<Secret> \| quote}`  | Quote a secret value.                |
| `${<Secret> \| base64}` | Base64 encode a secret value.        |

SST exports `value`, falling back to `name`; resources with neither are omitted.
Rendering fails if a referenced SST value is missing or empty.

## Examples

### Local k3d Cluster

```sh
# Start dependencies and create the k3d cluster
./scripts/cluster/main.sh k3d deps up
./scripts/cluster/main.sh k3d up

# Build and push local images/charts
pnpm local:build
pnpm local:push

# Deploy in two steps: bootstrap (helm charts + CRDs), then overlay
./scripts/cluster/main.sh deploy local --bootstrap
./scripts/cluster/main.sh deploy local

# Tear down everything
./scripts/cluster/main.sh k3d down
./scripts/cluster/main.sh k3d deps down
```

### Remote Cluster (Hetzner via Tailscale)

Provision SST stage `dev` (manual) or `production` (automatic from `main`) with Deploy Infrastructure, then use a checkout of
`deploy/dev` or `deploy/production` for bootstrap. Shared dev uses the `preview` resource prefix
and Tailscale hostname `preview-cluster`, preserving personal SST stages' existing names.

```sh
# Switch to the cloud cluster context
kubectl config use-context <tailscale-context>

# Two-step deploy on a fresh dev cluster (use prod for production)
./scripts/cluster/main.sh deploy dev --bootstrap
./scripts/cluster/main.sh deploy dev
```

### Render Without Applying

```sh
./scripts/cluster/main.sh deploy prod --dry-run
./scripts/cluster/main.sh deploy prod --bootstrap --dry-run

# On a prepared deploy/preview-123 checkout
./scripts/cluster/main.sh deploy preview --dry-run --quiet

# Save YAML-only stdout; errors go to stderr
./scripts/cluster/main.sh deploy prod --dry-run --quiet > rendered.yaml
```

---

If you add new commands or options, update `usage.sh` so help output stays
accurate, and document anything notable here for future contributors.
