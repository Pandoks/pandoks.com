# Cluster CLI

This directory contains the shell-based CLI used for managing local k3d clusters,
shared dependencies, and Kubernetes resources during development. All commands are
POSIX-compliant `sh` scripts—no Bash-specific features are required.

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

Without `--bootstrap`, deploys the **overlay** at `k3s/overlays/<env>`. With
`--bootstrap`, deploys the **bootstrap layer** at `k3s/bootstrap/<env>` instead
(helm charts, CRDs, base resources). The two are separate kustomize paths — to
deploy a fresh cluster end-to-end, run `deploy <env> --bootstrap` first, then
`deploy <env>` again without the flag.

| Environment | Description                                                                       |
| ----------- | --------------------------------------------------------------------------------- |
| `local`     | Local k3d cluster. ImageRegistry: `local-registry:5000`, ImageTag: `latest`.      |
| `dev`       | Dev cloud cluster. ImageRegistry: `ghcr.io/pandoks`, ImageTag: branch name (or `latest` on main/master). |
| `prod`      | Production cloud cluster. ImageRegistry: `ghcr.io/pandoks`, ImageTag: `latest`. SST stage forced to `production`. |

| Option        | Description                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `--bootstrap` | Apply `k3s/bootstrap/<env>` (helm charts + CRD providers) and wait for CRDs.                               |
| `--stage`     | SST stage to fetch secrets from (default: SST's default stage; forced to `production` for prod env).       |
| `--dry-run`   | Render templates without applying.                                                                         |
| `--kubeconfig`| Kubeconfig file for kubectl operations.                                                                    |
| `--quiet`/`-q`| Suppress status messages, output only YAML (for CI/CD).                                                    |

You will be prompted to confirm the destination kubectl context before anything
is applied (unless using `--dry-run`).

### Template Variables

The `deploy` command renders templates with these substitutions before applying:

| Variable                | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `${ImageRegistry}`      | Container registry (local-registry or GHCR).        |
| `${ImageTag}`           | Image tag (latest or branch name).                  |
| `${IsLocal}`            | `'true'` or `'false'` for conditional logic.        |
| `${<SST Resource>}`     | Any SST resource by name.                            |
| `${<Secret> \| base64}` | Base64 encode a secret value.                        |

## Examples

### Local k3d Cluster

```sh
# Start dependencies and create the k3d cluster
./scripts/cluster/main.sh k3d deps up
./scripts/cluster/main.sh k3d up

# Deploy in two steps: bootstrap (helm charts + CRDs), then overlay
./scripts/cluster/main.sh deploy dev --bootstrap
./scripts/cluster/main.sh deploy dev

# Tear down everything
./scripts/cluster/main.sh k3d down
./scripts/cluster/main.sh k3d deps down
```

### Cloud Cluster (Hetzner via Tailscale)

```sh
# Switch to the cloud cluster context
kubectl config use-context <tailscale-context>

# Two-step deploy on a fresh cluster
./scripts/cluster/main.sh deploy prod --bootstrap
./scripts/cluster/main.sh deploy prod

# Re-apply just the overlay (no bootstrap) on subsequent deploys
./scripts/cluster/main.sh deploy prod
```

### Preview Without Applying

```sh
./scripts/cluster/main.sh deploy prod --dry-run
./scripts/cluster/main.sh deploy prod --bootstrap --dry-run
```

---

If you add new commands or options, update `usage.sh` so help output stays
accurate, and document anything notable here for future contributors.
