# K3s

This is the k8s cluster that hosts most of the applications in this monorepo. The applications that
are not hosted in this cluster are hosted either in AWS or Cloudflare usually for serverless
applications. For databases, it is better to use a managed database as it reduces the operational
overhead.

As it stands, the dev and prod clusters are hosted on Hetzner VPS's.

## Directory Structure

```
k3s/
  base/                      # App resources, shared core, dashboards, custom image fields
  bootstrap/
    core/                    # MetalLB, cert-manager, HAProxy, Prometheus/Grafana
    local/                   # Core bootstrap for k3d
    cluster/                 # Core + Argo CD + upgrade-controller CRD
    dev/                     # Shared dev bootstrap
    prod/                    # Production bootstrap
  components/images/         # Native Kustomize image pins
  overlays/
    cluster/                 # Shared remote controllers, monitoring, node upgrades
    local/                   # Full local stack and registry overrides
    dev/                     # Shared infrastructure and preview ApplicationSet
    preview/                 # Per-PR apps/databases; namespace set in the prepared Git ref
    prod/                    # Production infrastructure and apps
```

SST secrets are substituted inline (`${Secret}`) by `pnpm cluster deploy`. See
[scripts/cluster/README.md](../scripts/cluster/README.md) for the template variables.

## Local Development

For local development, we use [k3d](https://k3d.io/) to create a local k3s cluster. Package images
use the `images:` overrides in
[`overlays/local/kustomization.yaml`](overlays/local/kustomization.yaml);
[`charts-patch.yaml`](overlays/local/charts-patch.yaml) selects the local chart registry.

To setup the cluster, run the following commands from the root of the project. Replace `your-stage`
with your personal SST stage (for example, `pandoks`):

```sh
SST_STAGE=your-stage pnpm local:init
```

Or step by step:

```sh
# Start docker compose dependencies (creates pandoks-net network)
./scripts/cluster/main.sh k3d deps up

# Create k3d cluster
./scripts/cluster/main.sh k3d up

# Build and push images/helm charts to the local registry
pnpm local:build && pnpm local:push

# Install base infrastructure (helm charts + CRDs)
./scripts/cluster/main.sh deploy local --stage your-stage --bootstrap

# Deploy local overlay (MetalLB IP patch + app patches; SST secrets substituted inline)
./scripts/cluster/main.sh deploy local --stage your-stage
```

## Previews and production

One dev cluster hosts PR previews; production runs in a separate cluster. Add the `preview` label to
a same-repository PR targeting `main` to opt in. CI builds its images/charts, waits for Checks,
Tests, and Security, then writes its source and exact image/chart versions to `deploy/preview-<PR>`.
Argo's ApplicationSet deploys that ref to namespace `preview-<PR>` at
`https://preview-<PR>.pandoks.com`. Closing the PR or removing the label deletes its resources,
including databases and data. Its Git ref is deleted; published registry artifacts are retained.
Preview backups are disabled.

Shared controllers, MetalLB, ingress, monitoring, and upgrades are deployed once from `deploy/dev`.
A successful opted-in PR that changes shared infrastructure updates it for every preview. The last
successful infrastructure update wins. The first preview seeds `deploy/dev`; afterward, app-only PRs
leave it alone. Closing a PR does not revert shared infrastructure. Labels never provision hardware.
Successful `main` builds publish `deploy/production` for automatic production sync; there is no
staging promotion step. CI publishes Git refs; Argo renders and applies them.

All remote overlays use the image pins in
[`components/images/kustomization.yaml`](components/images/kustomization.yaml). Kustomize matches
values at the fields in [`base/image-fields.yaml`](base/image-fields.yaml). Add new images to the CI
build matrix, shared pins, and local overrides. Deploy never queries a registry or generates image
patches. Each prepared ref includes `SOURCE_REVISION` for traceability.

### Bootstrap and manual recovery

**Deploy Infrastructure** runs SST stage `production` on `main` pushes that touch SST code. CI
deploys no other stage; deploy `dev` locally with `pnpm sst deploy --stage dev`. Configure node
counts and stage credentials first; they remain zero. Build a labeled PR (or `main` for production)
to prepare the deployment refs, then bootstrap from the corresponding checkout:

```sh
git fetch origin deploy/dev
git worktree add --detach ../dev-bootstrap FETCH_HEAD
cd ../dev-bootstrap
pnpm install --frozen-lockfile
kubectl config use-context <preview-cluster-context>
pnpm cluster deploy dev --bootstrap
pnpm cluster deploy dev
```

For production, use `deploy/production`, its context, and `deploy prod`. These checkouts include the
newly built renderer image. Manual deploys confirm the selected context; they never switch it.
Bootstrap waits for CRDs and controllers. Argo uses `deploy <env> --dry-run --quiet` to render the
same manifests without applying. The internal `preview` target requires `--dry-run` and cannot
bootstrap.

```sh
pnpm cluster deploy dev --dry-run --quiet > rendered.yaml
```

### Stage identities

| SST stage                      | Resource prefix | CLI target                    |
| ------------------------------ | --------------- | ----------------------------- |
| `production`                   | `prod`          | `prod`                        |
| `dev`                          | `preview`       | `dev` / render-only `preview` |
| Personal stage, e.g. `pandoks` | `dev`           | `local --stage pandoks`       |

Shared dev uses the `preview` prefix to preserve existing personal-stage and production identities.
Its Tailscale hostname is `preview-cluster`. Argo credentials can read only their own SST stage; CI
needs no Kubernetes credentials, and AWS trusts only the `production` GitHub environment and `main`.
Existing clusters need the new prepared overlay applied once; Git changes do not automatically
remove old resources while remote infrastructure pruning is disabled.

Preview ingress uses the shared dev cluster's public ingress and a wildcard `*.pandoks.com`
DNS/origin certificate. The dev stage provisions no public load balancer yet, so previews go live
with the OVH migration. First-level preview names work with Cloudflare Universal SSL; explicit
production and personal DNS records keep their existing routing.

### Versioned cluster upgrades

The upgrade controller and K3s Plan versions are pinned in Git. Update the shared bootstrap/overlay
controller URLs together. Dev upgrades immediately; production keeps its weekend maintenance window.

## k9s

### Local Development

`k3d` will automatically setup the kubeconfig and context for you. If the context changes, you can
run these commands to switch to the correct context:

```sh
kubectl config get-contexts
kubectl config use-context <context-name>
```

**NOTE:** `k3d` is setup to use port 6444 for the local k3s cluster api so that it doesn't conflict
with a remote k3s API forwarded to the default port 6443 (e.g. through SSH tunneling).

You'll also see in `scripts/cluster/k3d.sh` that we forward port 30080 in _docker_ to port 8080 on
the machine (`localhost`). This is because `k3d` runs k3s inside of docker and we need to expose the
ports that we're exposing from `NodePort` to the host machine. This also mimics the behavior of
production clusters because the cluster is inside a private networks and the only thing that is
exposed is through a load balancer that points into the private network at the forwarded port.

### Remote clusters

Dev and production are accessed via Tailscale. The tailscale operator exposes the API server to your
tailnet:

```sh
k9s --context <tailscale-context>
kubectl --context <tailscale-context> get pods
```

## Public Exposure

To expose the cluster's services to the public internet, you need to use ingress controllers. Load
balancers should only be used for external services that are in the same private network as the
cluster. Basically, services that are not in the cluster but they're in the same private network as
the VPS's.

### HAProxy Ingress Controller

`bootstrap/core/haproxy-ingress.yaml` is a HelmChart that installs the HAProxy ingress controller
and also configures `NodePort` services to expose to the Hetzner load balancer. Ports `30000-32767`
are reserved ports just for `nodePort` services. The cluster is entirely in a private network so we
only expose services via the load balancer which is exposed to the public internet but is also
connected to the private network.

Example `Ingress` resource:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: <ingress-name>
  namespace: <namespace>
  annotations:
    haproxy-ingress.github.io/rewrite-target: <rewrite-target>
    haproxy-ingress.github.io/ssl-redirect: true | false
spec:
  ingressClassName: haproxy
  tls:
    - hosts:
        - <hostname>
      secretName: <secret-name>
  rules:
    - host: <hostname>
      http:
        paths:
          - path: /
            pathType: Prefix | Exact
            backend:
              service:
                name: <service-name>
                port:
                  number: <service-port>
          - path: /<path>
            pathType: Prefix | Exact
            backend:
              service:
                name: <service-name>
                port:
                  number: <service-port>
```

| Path Type | Description                                                |
| --------- | ---------------------------------------------------------- |
| Prefix    | The path prefix matches the beginning of the request path. |
| Exact     | The path must match the request path exactly.              |

**NOTE:** The `Prefix` path type use longest path wins. This means that if specify path `/` and
`/foo`, `/foo`, `/foo/bar`, etc will all match the path `/foo`. Everything else will match to `/`.
`/` is usually used as a catch-all path.

## Monitoring (Prometheus + Grafana)

The cluster uses kube-prometheus-stack for monitoring. Its shared HelmChart is in the bootstrap
layer; environment overlays supply the different etcd endpoints through HelmChartConfig resources.

### Structure

```
k3s/bootstrap/core/kube-prometheus-stack.yaml → shared HelmChart, Grafana secret, and configuration
k3s/base/core/monitoring.yaml                  → Tailscale Service annotations
k3s/base/monitoring/                           → shared Grafana dashboard ConfigMaps
k3s/overlays/local/prom-etcd-config.yaml       → k3d etcd endpoints (172.30.0.4-6)
k3s/overlays/cluster/prom-etcd-config.yaml     → Hetzner etcd endpoints (10.0.1.10+)
```

### etcd Metrics

k3s embedded etcd requires `--etcd-expose-metrics` flag to expose metrics on port 2381:

- **k3d**: Set via `--k3s-arg "--etcd-expose-metrics@server:*"` in `scripts/cluster/k3d.sh`
- **Hetzner**: Set in `infra/vps/cloud-config.yaml`

The kube-prometheus-stack `kubeEtcd.endpoints` must list control plane IPs explicitly because k3s
doesn't create pods with `component=etcd` labels (embedded etcd).

### Grafana Datasource Provisioning

Grafana uses the default sidecar-based provisioning. Earlier versions had a race condition
(REQ_SKIP_INIT bug) but this was fixed in Grafana helm chart 10.5.8 (included in
kube-prometheus-stack 80.14.4+).

### Updating Helm Values

k3s HelmChart CRD sometimes doesn't trigger upgrades. To force update:

```bash
kubectl delete helmchart kube-prometheus-stack -n kube-system
pnpm cluster deploy local --stage your-stage  # or dev/prod
```
