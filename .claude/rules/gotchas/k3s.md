---
paths:
  - 'k3s/**'
  - 'scripts/cluster/**'
  - 'scripts/lib/template.sh'
  - 'scripts/lib/sst-resources.ts'
  - 'packages/argocd/**'
---

# Gotchas — k3s/ (cluster manifests)

Kustomize-based layering on top of k3s, rendered by the cluster CLI
(`scripts/cluster/main.sh deploy <env>`) with SST-secret substitution
inline. ArgoCD's CMP runs the same CLI inside the repo-server pod.

## Layering

```
k3s/
  base/                       Shared foundation (all envs)
    core/                     Stateless infra patches (creds, MetalLB, cert-manager, tailscale, monitoring, namespaces, postgres/valkey RBAC)
    helm-charts/              (charts installed via bootstrap layer)
    apps/                     Cross-traverses to apps/<name>/kube/ — needs --load-restrictor LoadRestrictionsNone
  bootstrap/                  CRDs + helm charts (applied first, with --bootstrap)
    local/                    → ../core
    dev/                      → ../core + system-upgrade-controller CRD
    prod/                     → ../core + ArgoCD + system-upgrade-controller CRD
  overlays/                   Patches + per-env config (applied second, no --bootstrap)
    cluster/                  Shared cluster overlay (tailscale + cluster-upgrade-plan + etcd metrics config)
    local/                    k3d overlay (MetalLB IP 172.30.100.x, etcd IPs 172.30.0.x)
    dev/                      → ../cluster + ../../bootstrap/dev
    prod/                     → ../cluster + ../../bootstrap/prod + argocd.yaml (App-of-Apps root)
  templates/                  (Used by SST-template substitution; not a kustomize path)
```

## Two-phase deploy

The cluster CLI picks the kustomize path from the `--bootstrap` flag
(`scripts/cluster/deploy.sh:186-189`):

```
--bootstrap ✓  →  k3s/bootstrap/<env>   (CRDs + helm charts; wait for CRDs)
--bootstrap ✗  →  k3s/overlays/<env>    (everything else)
```

Sequence for a fresh cluster (local or prod, same shape):

```sh
pnpm cluster deploy <env> --bootstrap   # phase 1
pnpm cluster deploy <env>               # phase 2
```

The split exists because helm charts in phase 1 install the CRDs
(cert-manager `Certificate`, MetalLB `IPAddressPool`, Prometheus
`ServiceMonitor`, ArgoCD `Application`) that phase 2's resources
reference. `deploy.sh:90-126` runs CRD-wait loops between the two
phases. Applying overlay first = silent CRD-missing failures.

## Per-environment specifics

| Env       | MetalLB pool                       | etcd IPs                | Tailscale operator | ArgoCD App-of-Apps |
| --------- | ---------------------------------- | ----------------------- | ------------------ | ------------------ |
| `local`   | `172.30.100.1-172.30.100.200` (`k3s/overlays/local/dev-patch.yaml:1-8`) | `172.30.0.4-6` (k3d) | ❌                 | ❌                 |
| `dev`     | (no inbound; cluster-overlay only) | (cluster overlay)       | ✅ (via cluster/)  | ❌                 |
| `prod`    | `10.0.1.100-10.0.1.200` (`k3s/base/core/metallb.yaml:1-9`)              | Hetzner CP IPs (`10.0.1.10+`) | ✅            | ✅ (`overlays/prod/argocd.yaml:47-69`) |
| `cluster` | (intermediate overlay — not deployed directly; `dev`/`prod` include it) |                         |                    |                    |

The `overlays/cluster/` overlay is the shared parent for `dev` and
`prod` — it carries the Tailscale operator HelmChart, the
weekend-window cluster-upgrade-plan, and the etcd-metrics
HelmChartConfig.

## Chart sources

All helm charts are pulled from upstream OCI/HTTPS repos at deploy
time, **not vendored**. Pinned versions are in
`k3s/bootstrap/core/*.yaml` and `k3s/overlays/cluster/tailscale.yaml`:

| Chart                  | Version  | Source                                                                |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| MetalLB                | 0.15.3   | `https://metallb.github.io/metallb`                                   |
| cert-manager           | 1.19.2   | `https://charts.jetstack.io`                                          |
| HAProxy-Ingress        | 0.15.1   | `https://haproxy-ingress.github.io/charts`                            |
| kube-prometheus-stack  | 80.14.4  | `https://prometheus-community.github.io/helm-charts`                  |
| tailscale-operator     | 1.92.5   | `https://pkgs.tailscale.com/helmcharts`                               |

App charts (postgres, valkey, clickhouse) are published as OCI images
under `oci://ghcr.io/pandoks/charts/<name>` by `build-and-publish.yaml`
— consumed by app manifests, not by k3s/base/.

## Template substitution

The CLI renders manifests through `scripts/lib/template.sh` after
`kubectl kustomize`. Two variable sources are merged:

1. **SST resources** — `pnpm sst shell node scripts/lib/sst-resources.ts`
   returns every `Resource.X.value` as a flat JSON object
   (`KwokPhoneNumber`, `GithubPersonalAccessToken`,
   `MainMainPostgresSuperuserPassword`,
   `KubernetesGrafanaAdminPassword`, `HetznerOriginTlsCrt`, etc.).
2. **Computed vars** (`scripts/cluster/deploy.sh:35-43`) —
   `${ImageRegistry}`, `${ImageTag}`, `${IsLocal}`.

Filters supported by `template_substitute` (`scripts/lib/template.sh:9-23`):

- `${VAR | base64}` — base64-encode (used for cert/key fields in
  `Secret.data`, e.g. `k3s/base/core/credentials.yaml:39-40`).
- `${VAR | quote}` — YAML-safe single-quote with doubling.
- `${VAR | bcrypt}` — htpasswd-style hash.

Unrecognized `${...}` patterns pass through unchanged — easy to miss a
typo since rendering won't fail. Always grep for your new variable in
the rendered output during dry-run.

## ArgoCD App-of-Apps (prod only)

`k3s/overlays/prod/argocd.yaml:47-69` defines the `prod-cluster`
Application that watches `k3s/overlays/prod` via the
`kustomize-sst-render-v1.0` CMP. The CMP sidecar
(`ghcr.io/pandoks/argocd-sst-plugin:main`,
`packages/argocd/argocd-plugin.yaml`) runs:

```sh
sh ./scripts/cluster/main.sh deploy prod --dry-run --quiet
```

inside the repo-server pod. Implications:

- The CMP signature is the CLI signature. **A breaking change to
  `deploy`'s flags or output silently breaks ArgoCD** — version-bump
  `argocd-sst-plugin` after any CLI change (see
  `gotchas/cluster.md`).
- `--dry-run --quiet` produces YAML only. Adding `printf`/`echo` to
  stdout in `deploy.sh` would corrupt the manifest stream — write
  status to stderr via `log_status` instead
  (`scripts/cluster/deploy.sh:5-8`).
- `syncPolicy.automated.prune: false` and `selfHeal: false` — drift is
  surfaced, never auto-corrected. Manual sync is the contract.

## Adding a new app

`apps/example/kube/` is the working template (note: `apps/example` is
itself CI-excluded per `universal.md`, but its manifests still ship to
clusters via `k3s/base/apps/kustomization.yaml`). What's load-bearing
vs. example-noise:

| Pattern in `apps/example` | Load-bearing? |
| ------------------------- | ------------- |
| Per-app `kustomization.yaml` resources list | ✅ |
| Three-section `Ingress` shape (HTTPS host + `localhost` fallback) with `cloudflare-origin-tls` | ✅ |
| `ingressClassName: haproxy` | ✅ |
| `dev-patch.yaml` overriding the hostname for the dev env | ✅ (when the app needs a `*.dev.pandoks.com` subdomain) |
| Specific busybox/postgres/valkey/clickhouse sidecars in `example.yaml` | ❌ — domain-specific to the example app |
| Multi-Ingress fragmentation (HAProxy auto-merges) | ❌ — only when an app needs distinct annotations per path |

### Step-by-step

1. **Create `apps/<name>/kube/<name>.yaml`** with `Deployment`,
   `Service`, `Ingress`, plus a `ServiceMonitor` if Prometheus
   integration is desired (auto-discovered cluster-wide — bootstrap
   chart values set ServiceMonitor selectors to nil; see
   `k3s/bootstrap/core/kube-prometheus-stack.yaml`).
2. **Create `apps/<name>/kube/kustomization.yaml`** listing the
   above files under `resources:`.
3. **Add `- ../../../apps/<name>/kube`** to
   `k3s/base/apps/kustomization.yaml`. The cross-traversal needs
   `--load-restrictor LoadRestrictionsNone` (the CLI passes it
   automatically at `scripts/cluster/deploy.sh:81`).
4. **Add the namespace** to `k3s/base/core/namespaces.yaml`.
5. **Add per-namespace credentials** to `k3s/base/core/credentials.yaml`
   following the canonical 3-block pattern from
   `k3s/base/core/credentials.yaml:1-40` (real example for the
   `example` namespace):
   - `Secret/ghcr-auth` of type `kubernetes.io/dockerconfigjson` —
     **only when pulling from a private ghcr repo**. Public images
     (e.g., `ghcr.io/sissbruecker/linkding:latest`,
     `docker.io/library/redis:7`) skip this block.
   - `ServiceAccount/default` with `imagePullSecrets: [ghcr-auth]` —
     makes every pod in the namespace pull from ghcr without needing
     `imagePullSecrets` in the podspec. Skip if no `ghcr-auth`.
   - `Secret/cloudflare-origin-tls` of type `kubernetes.io/tls` with
     `tls.crt: ${HetznerOriginTlsCrt | base64}` and
     `tls.key: ${HetznerOriginTlsKey | base64}` — required for HAProxy
     TLS termination (Cloudflare is in Full Strict mode, so the origin
     must present a cert).
6. **App-specific SA only if the app needs operator-style RBAC** (like
   `k3s/base/core/postgres.yaml:55` — `# NOTE: you need one service
   account per namespace`). Most apps don't — the `default` SA from
   step 5 is enough.
7. **SST secrets**: declare `new sst.Secret('<Name>')` in
   `infra/secrets.ts` under the appropriate flat namespace
   (`personal`, `twilio`, etc. — k8s-tree nesting is only for
   collision-prone names per `conventions/infra.md`). Reference in
   manifests as `${<Name> | quote}` for string values.
8. **Per-env hostname patch** (only when the dev hostname differs from
   prod): create `apps/<name>/kube/dev-patch.yaml` overriding the
   `Ingress` `host:` to `<name>.dev.pandoks.com`, then add
   `- path: ../../../apps/<name>/kube/dev-patch.yaml` to the `patches:`
   block in `k3s/overlays/local/kustomization.yaml` and (if needed)
   `k3s/overlays/dev/kustomization.yaml`. **`overlays/dev/` does not
   currently have a `patches:` block** — the first dev-only ingress
   patch will create it. Dev DNS (`<name>.dev.pandoks.com`) is **not**
   auto-provisioned; coordinate with `infra/cloudflare.ts` if the
   subdomain doesn't exist yet.

### Boilerplate `ServiceMonitor` shape

Prometheus auto-discovers cluster-wide (selectors are nil in the
bootstrap chart). Live examples: `packages/valkey/chart/templates/monitoring.yaml`,
`packages/postgres/chart/templates/monitoring.yaml`,
`packages/clickhouse/chart/templates/monitoring.yaml` (these are Helm
templates; the plain-YAML equivalent for an app is below).

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: <app>
  namespace: monitoring          # ServiceMonitors live in monitoring/
  labels:
    app: <app>
spec:
  namespaceSelector:
    matchNames:
      - <app>                    # the app's own namespace
  selector:
    matchLabels:
      app: <app>                 # must match the Service's labels
  endpoints:
    - port: metrics              # must match the named port on the Service
      path: /metrics
      interval: 30s
      scheme: http
```

Three things must line up: the **Service** has a named port (e.g.,
`metrics`), the **ServiceMonitor** references that name in
`endpoints[].port`, and the `selector.matchLabels` matches the
Service's `metadata.labels`. After first deploy, verify with
`kubectl get servicemonitor -n monitoring <app>` and check Prometheus
targets at the Grafana datasource.

### Cloudflare DNS for new subdomains

**Cluster-fronted hosts (`<app>.pandoks.com` and
`<app>.dev.pandoks.com`):** `infra/cloudflare.ts:16-37` creates per-host
`A`/`AAAA` records pointing to each load-balancer IP — there is **no
wildcard `*.pandoks.com` or `*.dev.pandoks.com` record**. The block
is currently gated `!isProduction` and only covers `EXAMPLE_DOMAIN`.

When adding a new cluster app you must add explicit DNS:

- **Dev hostname (`<app>.dev.pandoks.com`)** — drop a new
  `<App>DomainLoadBalancer${i}Ipv4` / `…Ipv6` pair inside the existing
  `if (publicLoadBalancers.length && !isProduction)` loop at
  `infra/cloudflare.ts:16`, mirroring the `ExampleDomainLoadBalancer…`
  shape with `name: '<app>.dev.pandoks.com'`.
- **Prod hostname (`<app>.pandoks.com`)** — **no precedent yet in
  `infra/`.** The prod node-count is currently 0
  (`infra/vps/vps.ts:9, 11`), so no prod LB exists to point a record
  at. When prod cluster nodes are first brought up, the prod DNS pattern
  has to be defined — likely a sibling `if (publicLoadBalancers.length
  && isProduction)` block in `infra/cloudflare.ts` with the same
  per-app record shape but without the dev hostname. Flag this to the
  user when adding the first prod cluster app; do not invent the
  pattern silently.

**Cloudflare-Pages-fronted subdomains** (web apps, not cluster
services): the pattern is `infra/website.ts:43-49` —
`cloudflare.DnsRecord` of type `CNAME` proxied to `<project>.pages.dev`.

### Renovate version pins

Repo-wide `rangeStrategy: pin` is set in `renovate.json:14`. Every
image tag should be a real version, never `:latest`. When adding a new
app, annotate the `image:` line with a trailing comment so Renovate
owns the bumps:

```yaml
image: ghcr.io/pandoks/<app>:v1.2.3 # renovate: datasource=docker packageName=ghcr.io/pandoks/<app>
```

There is no existing custom regex manager for `image:` lines in
`apps/**/kube/**/*.yaml` (only `version:` — `renovate.json:36-44`).
Renovate's built-in `kubernetes` manager covers `image:` references in
standard k8s manifests, so the trailing comment is usually
sufficient. Only add a new `customManagers` entry if you find a
specific case the built-in skips.

### Boilerplate `Ingress` shape (copy from `apps/example/kube/example.yaml`)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: <app>
  namespace: <app>
spec:
  ingressClassName: haproxy
  tls:
    - hosts:
        - <app>.pandoks.com
      secretName: cloudflare-origin-tls
  rules:
    - host: <app>.pandoks.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: <app>, port: { number: 80 } }
    - host: localhost
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: <app>, port: { number: 80 } }
```

The `localhost` rule is the loopback fallback used during local
testing — keep it.

### Stateful apps

The only in-tree app today (`apps/example`) is stateless. For stateful
apps (Gitea, Plausible's embedded Postgres+ClickHouse, anything
sqlite-backed):

- **Use `StatefulSet` + `volumeClaimTemplates`**, not `Deployment`,
  when the app owns its own storage on disk.
- **Prefer an external managed database** (`packages/postgres`,
  `packages/clickhouse`, `packages/valkey`) over an embedded one when
  the app supports it. The cluster already runs these via Helm charts
  under namespace `main` — provision a dedicated DB + user inside that
  namespace and pass `DATABASE_URL` to the app via a `Secret`.
- **PVC storage class**: k3d ships with `local-path` (default). Prod
  Hetzner clusters need their own storage class declared before
  PVCs work — no precedent yet in `k3s/base/`. **Flag this to the
  user before shipping a prod stateful app** and document the chosen
  storage class here.
- **Backup**: the cluster's `BackupBucket` (Cloudflare R2,
  `infra/storage.ts`) is wired only for Patroni WAL + ClickHouse so
  far. New stateful apps need their own backup story — write a
  CronJob, mount the `BackupBucket` credentials, document the
  restore path. Without this, a PVC loss = data loss.

### SST-secret auto-generation

Some secrets are operator-set via `pnpm sst secret set <Name>`
(e.g., `KwokPhoneNumber`, `NotionApiKey`); others are
auto-generated during deploy via the `setSecret()` helper at
`infra/secrets.ts:81`. Real auto-gen examples:

- `infra/cloudflare.ts:63-69, 85-93` — TLS key + cert generated via
  `openssl`, piped into `sst secret set` via stdin.
- `infra/tailscale.ts:63-91` — OAuth client created by `tailscale.OauthClient`
  resource, its `id` + `key` outputs written back via `setSecret`.
- `infra/dns.ts:11-15, 22-27` — `StageName` / `AwsRegion` auto-synced
  on deploy.

When introducing a secret the app itself should generate (session
keys, encryption keys, signing secrets), follow this pattern: declare
the `sst.Secret` with a placeholder value, then add a one-shot
generator block in the relevant `infra/*.ts` that runs once and
`setSecret()`s the real value. Operator `sst secret set` is the
fallback when the value comes from the user (phone numbers, API
tokens).

### Removing an app

When deleting an app, strip every layer it touched: the
`apps/<name>/kube/` directory, the `- ../../../apps/<name>/kube` line
in `k3s/base/apps/kustomization.yaml`, the namespace in
`namespaces.yaml`, the per-namespace credentials block in
`credentials.yaml`, the SST secret in `infra/secrets.ts`, and any
overlay `patches:` entries. The cluster won't garbage-collect the
namespace on its own — `kubectl delete namespace <name>` after the
manifests are gone.

## Adding / bumping a helm chart

Bootstrap-layer charts (`k3s/bootstrap/core/*.yaml`) are k3s
`HelmChart` CRs. Bumping `version:` will **not** always trigger an
upgrade — k3s's HelmChart controller has an upgrade-skip quirk. Force
it:

```sh
kubectl delete helmchart <name> -n kube-system
pnpm cluster deploy <env>
```

(see `k3s/README.md` Updating Helm Values section).

Renovate is configured to track these versions
(`renovate.json`, run by `maintenance.yaml`); accept its PRs rather
than bumping by hand to keep the audit trail.

## Footguns

1. **`k3s/base/apps/kustomization.yaml` cross-traverses** to
   `apps/<name>/kube` — must apply with `--load-restrictor
   LoadRestrictionsNone`. The CLI does this; raw `kubectl apply -k`
   will fail with `security; file is not in or below`.
2. **k3d API port is 6444**, not 6443 — avoids SSH-tunnel conflict
   with remote prod (`scripts/cluster/k3d.sh:37`).
3. **Tailscale operator is prod-only**
   (`k3s/base/core/tailscale.yaml:2`). Don't reference its CRDs from
   any base/ or local-overlay manifest — they won't exist on k3d.
4. **etcd endpoints are hardcoded per-env** in
   `prom-etcd-config.yaml` because k3s's embedded etcd doesn't label
   pods with `component=etcd`. Cluster topology changes require manual
   IP updates.
5. **Renderer is silent on unknown `${VAR}`** — typos pass through.
   Dry-run + grep is mandatory when introducing new variables.
6. **Production `--stage` is forced to `production`**
   (`scripts/cluster/deploy.sh:184` — `[ "${cmd_deploy_env}" = "prod" ] && cmd_deploy_stage="production"`)
   — `deploy prod --stage anything` is overridden. By design, prevents
   leaking dev secrets to prod.
7. **HelmChart upgrade quirk** above — quietly skips chart upgrades on
   version bump; `kubectl delete helmchart` is the escape hatch.
8. **CMP plugin image must be re-pulled** after `deploy.sh` changes —
   bump the image tag, don't rely on `:main` cache.

## Operator workflow cheat sheet

```sh
# Local k3d, fresh cluster:
pnpm cluster k3d deps up
pnpm cluster k3d up
pnpm cluster deploy local --bootstrap
pnpm cluster deploy local

# Tear down local:
pnpm cluster k3d down
pnpm cluster k3d deps down

# Prod (via Tailscale):
sudo tailscale configure kubeconfig prod-cluster
pnpm cluster deploy prod --bootstrap   # only on fresh cluster
pnpm cluster deploy prod

# Force-resync an ArgoCD app after CLI/CMP changes:
sudo kubectl annotate application prod-cluster \
  argocd.argoproj.io/refresh=hard --overwrite --namespace argocd

# Preview without applying:
pnpm cluster deploy prod --dry-run
```
