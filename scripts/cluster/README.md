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
`./scripts/cluster/main.sh`, so you can invoke everything via `pnpm run` as well.

## Top-Level Commands

| Command         | Description                                                     |
| --------------- | --------------------------------------------------------------- |
| `k3d`           | Manage the local k3d cluster (create, delete, start...).        |
| `deps`          | Start/stop the Docker Compose dependency stack.                 |
| `setup-cluster` | Install addons (MetalLB, cert-manager) and apply k3s manifests. |
| `push-secrets`  | Fetch SST secrets and push them into the active cluster.        |

## k3d Subcommands

```sh
./scripts/cluster/main.sh k3d <subcommand> [options]
```

| Subcommand | Description                                           |
| ---------- | ----------------------------------------------------- |
| `up`       | Create `local-cluster` (supports `--network <name>`). |
| `down`     | Delete the cluster if it exists.                      |
| `start`    | Start an existing cluster.                            |
| `stop`     | Stop the running cluster.                             |
| `restart`  | Stop and start the cluster sequentially.              |

## setup-cluster Options

`setup-cluster` accepts several flags to control how networking is configured:

- `--kubeconfig <path>` – operate against a specific kubeconfig file.
- `--k3d` – auto-detect the IP pool from the local k3d network.
- `--ip-pool <range>` – explicitly set an IP pool (`CIDR` or `start-end`).
- `--network <name>` – set the Docker network used while auto-detecting pools.

Either `--k3d`, `--ip-pool`, or the `IP_POOL_RANGE` environment variable must be
provided; otherwise the command prints usage instructions and exits.

## push-secrets Options

`push-secrets` pulls secrets from SST and applies them to the cluster through
`kubectl`:

- `--kubeconfig <path>` – target a custom kubeconfig (falls back to current context).

You will always be prompted to confirm the destination context before anything is
applied.

## Examples

```sh
# Create the k3d cluster and install addons with the auto-detected IP pool
./scripts/cluster/main.sh k3d up
./scripts/cluster/main.sh setup-cluster --k3d

# Start dependencies, rebuild services, then push secrets
./scripts/cluster/main.sh deps up
./scripts/cluster/main.sh push-secrets --kubeconfig ./k3s.yaml

# Tear down everything
./scripts/cluster/main.sh k3d down
./scripts/cluster/main.sh deps down
```

---

If you add new commands or options, update `usage.sh` so help output stays
accurate, and document anything notable here for future contributors.
