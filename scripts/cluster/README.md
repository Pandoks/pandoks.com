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

| Command     | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| `k3d`       | Manage the local k3d cluster and dependencies.                 |
| `core`      | Apply core infrastructure (helm charts, CRDs, base resources). |
| `deploy`    | Deploy environment-specific overlay (dev or prod).             |
| `sync`      | Run core + deploy together (recommended for most operations).  |
| `sst-apply` | Render SST templates and apply to cluster.                     |

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

## core

`core` installs the base infrastructure (helm charts + core resources):

- MetalLB, cert-manager, HAProxy Ingress
- Waits for CRDs to be established
- Applies core resources (IPAddressPool, cert-manager issuers, namespaces)

Prompts for confirmation with current kubectl context.

## sync

`sync` runs `core` + `deploy` together. This is the recommended command for most operations:

```sh
./scripts/cluster/main.sh sync <dev|prod>
```

It applies all helm charts, waits for CRDs, applies core resources, then deploys the environment overlay.

## deploy

`deploy` applies environment-specific overlays:

```sh
./scripts/cluster/main.sh deploy <dev|prod>
```

| Environment | Description                                                                                |
| ----------- | ------------------------------------------------------------------------------------------ |
| `dev`       | For **local k3d clusters**: MetalLB IP patch for docker network (172.30.0.x etcd IPs)      |
| `prod`      | For **cloud clusters** (Hetzner): Tailscale, system-upgrade controller (10.0.1.x etcd IPs) |

**Important:** The `dev`/`prod` overlay refers to the **k3s configuration** (etcd IPs, networking),
not the SST stage. For cloud clusters (even staging environments), use `sync prod`. The SST stage
is specified separately via `sst-apply --stage <STAGE>`.

## sst-apply Usage

`sst-apply` renders templates with SST secrets and applies them to the cluster via
`kubectl apply --server-side`:

```sh
./scripts/cluster/main.sh sst-apply <FILE|all> [--stage <STAGE>] [--dry-run] [--kubeconfig <path>]
```

- `<FILE>` – template file with `${VAR}` placeholders.
- `all` – applies all templates (monitoring, apps, tailscale).
- `--stage <STAGE>` – SST stage to fetch secrets from (default: current user stage).
- `--dry-run` – show rendered YAML without applying to cluster.
- `--kubeconfig <path>` – target a custom kubeconfig (falls back to current context).

### Template Syntax

- `${VAR}` – plain substitution from SST secret value.
- `${VAR | filter}` – apply a filter to the value before substitution.

Available filters:
| Filter | Description |
| -------- | -------------------------- |
| `base64` | Base64 encode the value |

Example:

```yaml
stringData:
  password: ${MySecret}
data:
  tls.crt: ${TlsCert | base64}
```

You will always be prompted to confirm the destination context before anything is
applied (unless using `--dry-run`).

## Examples

### Local k3d Cluster

```sh
# Start dependencies and create the k3d cluster
./scripts/cluster/main.sh k3d deps up
./scripts/cluster/main.sh k3d up

# Deploy everything (core + dev overlay)
./scripts/cluster/main.sh sync dev

# Apply SST secrets (uses your default stage)
./scripts/cluster/main.sh sst-apply all

# Tear down everything
./scripts/cluster/main.sh k3d down
./scripts/cluster/main.sh k3d deps down
```

### Cloud Cluster (Hetzner via Tailscale)

```sh
# Switch to the cloud cluster context
kubectl config use-context <tailscale-context>

# Deploy everything (core + prod overlay for cloud)
./scripts/cluster/main.sh sync prod

# Apply SST secrets for the specific stage
./scripts/cluster/main.sh sst-apply all --stage dev        # for dev-cluster
./scripts/cluster/main.sh sst-apply all --stage production # for prod-cluster
```

### Step by Step

```sh
./scripts/cluster/main.sh core       # Install base infrastructure only
./scripts/cluster/main.sh deploy dev # Deploy overlay only

# Preview rendered SST templates (dry-run)
./scripts/cluster/main.sh sst-apply all --dry-run --stage production
```

---

If you add new commands or options, update `usage.sh` so help output stays
accurate, and document anything notable here for future contributors.
