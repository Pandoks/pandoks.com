# K3s

This is the k8s cluster that hosts most of the applications in this monorepo. The applications that
are not hosted in this cluster are hosted either in AWS or Cloudflare usually for serverless
applications. For databases, it is better to used a managed database as it reduces the operational
overhead.

Each regional production cluster can combine OVHcloud Public Cloud instances
and dedicated servers. `infra/cluster/config.ts` defines independent templates
for US West, US East, Europe, and Asia; all are currently disabled with zero
nodes. Regional clusters do not share a Kubernetes control plane.

## Directory Structure

```
k3s/
  base/                      # Shared foundation (dev + prod)
    kustomization.yaml       # Includes helm-charts + core + apps
    helm-charts/             # MetalLB, cert-manager, HAProxy, Prometheus/Grafana
    core/                    # IPAddressPool, cert-manager issuers, namespaces
    apps/                    # References to packages/*/kube
  overlays/
    dev/                     # Dev-specific config
      kustomization.yaml     # base + patches
      dev-patch.yaml         # MetalLB IP for docker network (172.30.100.1-172.30.100.200)
    prod/                    # Prod-specific config
      kustomization.yaml     # base + tailscale + system-upgrade
      tailscale.yaml         # Tailscale operator + ClusterRoleBinding
      cluster-upgrade-plan.yaml  # System upgrade plans for auto-updates
  templates/                 # SST secret templates (envsubst)
    monitoring.yaml          # Grafana secrets
    apps.yaml                # App secrets (ghcr, postgres, valkey, clickhouse)
    tailscale.yaml           # Tailscale OAuth secrets (prod only)
```

## Local Development

For local development, we use [k3d](https://k3d.io/) to create a local k3s cluster.

To setup the cluster, run the following commands from the root of the project:

```sh
pnpm dev:init
```

Or step by step:

```sh
# Start docker compose dependencies (creates pandoks-net network)
./scripts/cluster/main.sh k3d deps up

# Create k3d cluster
./scripts/cluster/main.sh k3d up

# Install base infrastructure (helm charts + CRDs)
./scripts/cluster/main.sh deploy dev --bootstrap

# Deploy dev overlay (MetalLB IP patch + app patches; SST secrets substituted inline)
./scripts/cluster/main.sh deploy dev
```

## Production

Production nodes are provisioned by SST/Pulumi. Public Cloud nodes use
user data and dedicated nodes use a post-install customization; both execute
the shared `infra/cluster/providers/bootstrap.sh` host hardening and k3s setup.
The Tailscale operator provides secure access to the cluster API without SSH
tunnels.

```sh
# Connect via tailscale (cluster appears as <stage>-cluster in your tailnet)
kubectl --context <tailscale-context> get pods

# Install base infrastructure (helm charts + CRDs)
./scripts/cluster/main.sh deploy prod --region us-west --bootstrap

# Deploy prod overlay (system-upgrade controller; SST secrets substituted inline)
./scripts/cluster/main.sh deploy prod --region us-west
```

## k9s

### Local Development

`k3d` will automatically setup the kubeconfig and context for you. If the context changes, you can
run these commands to switch to the correct context:

```sh
kubectl config get-contexts
kubectl config use-context <context-name>
```

**NOTE:** `k3d` is setup to use port 6444 for the local k3s cluster API so that it doesn't conflict
with the remote k3s API over Tailscale.

You'll also see in `scripts/cluster/k3d.sh` that we forward port 30080 in _docker_ to port 8080 on the
machine (`localhost`). This is because `k3d` runs k3s inside of docker and we need to expose the
ports that we're exposing from `NodePort` to the host machine. This also mimics the behavior of
production clusters because the cluster is inside a private networks and the only thing that is
exposed is through a load balancer that points into the private network at the forwarded port.

### Production

Production clusters are accessed via Tailscale. The tailscale operator exposes the API server
to your tailnet:

```sh
k9s --context <tailscale-context>
kubectl --context <tailscale-context> get pods
```

## Public Exposure

To expose services publicly, mark eligible pools with `publicIngress`. One
eligible node is used directly; multiple nodes use one or more regional OVH
load balancers. Cloudflare proxies one origin directly and creates global load
balancing when two or more regional origins exist. Database pools remain
private and applications are routed internally by Kubernetes Services.

### HAProxy Ingress Controller

`base/helm-charts/haproxy-ingress.yaml` is a helm chart that installs the HAProxy ingress controller and
also configures `NodePort` services to expose to the OVH load balancer. Ports `30000-32767` are
reserved ports just for `nodePort` services. The cluster is entirely in a private network so we only
expose services via the load balancer which is exposed to the public internet but is also connected
to the private network.

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

The cluster uses kube-prometheus-stack for monitoring. The HelmChart is defined per-environment in
overlays because etcd endpoints are environment-specific.

### Structure

```
k3s/base/core/namespaces.yaml          → monitoring namespace
k3s/overlays/dev/prom-grafana.yaml     → HelmChart with k3d control plane IPs (172.30.0.4-6)
k3s/overlays/prod/prom-grafana.yaml    → HelmChart with active OVH control-plane IPs
k3s/templates/monitoring.yaml          → Grafana secrets (SST template)
```

### etcd Metrics

k3s embedded etcd requires `--etcd-expose-metrics` flag to expose metrics on port 2381:

- **k3d**: Set via `--k3s-arg "--etcd-expose-metrics@server:*"` in `scripts/cluster/k3d.sh`
- **OVHcloud**: Set by `infra/cluster/providers/bootstrap.sh`

Within each regional `10.<region>.0.0/16`, Public Cloud control planes use
`.1.1-.1.254` and dedicated control planes use `.3.1-.3.254`. Keep each
cluster's explicit etcd endpoint list aligned with its active members.

Flannel only connects pods inside one cluster. Cross-region pod/service
connectivity (for example, Cilium Cluster Mesh) and database replication are a
separate rollout; the unique regional pod/service CIDRs reserve that future
path without forcing readdressing.

The kube-prometheus-stack `kubeEtcd.endpoints` must list control plane IPs explicitly because
k3s doesn't create pods with `component=etcd` labels (embedded etcd).

### Grafana Datasource Provisioning

Grafana uses the default sidecar-based provisioning. Earlier versions had a race condition
(REQ_SKIP_INIT bug) but this was fixed in Grafana helm chart 10.5.8 and is included in the pinned
kube-prometheus-stack chart.

### Updating Helm Values

k3s HelmChart CRD sometimes doesn't trigger upgrades. To force update:

```bash
kubectl delete helmchart kube-prometheus-stack -n kube-system
pnpm cluster deploy dev  # or prod
```
