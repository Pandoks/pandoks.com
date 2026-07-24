# Architecture (overview)

Always-loaded. High-level topology so future sessions know what exists where.
Area-specific architecture details live in `.claude/rules/gotchas/*.md` and
`.claude/rules/conventions/*.md`.

Single SST 4 app (`sst.config.ts:5`, `name: 'personal'`) drives AWS,
Cloudflare, OVHcloud, GitHub, Tailscale. Two stages: `production` and
`pandoks` (per-user dev).

`infra/sandbox/` and `apps/functions/src/sandbox/` exist as `.gitkeep`-only
scaffolding — the apartment-scraper experiment lived here until it was
removed. Future sandbox modules should be imported from `sst.config.ts`
the same way `infra/sandbox/apartment-search.ts` used to be (literal
`import('./infra/sandbox/<name>')` in the `Promise.all` at `:35-49`),
with stage gating _inside_ the sandbox file rather than at the import
site.

## Layering

```
sst.config.ts ─┬─ infra/*.ts                 IaC: AWS, CF, GH, OVH, Tailscale
               └─ apps/* + packages/*        Deploy targets bound by SST resources

apps/
  web/             SvelteKit 2 + Svelte 5 static site → Cloudflare Pages (PWA)
  functions/       AWS Lambda handlers (Node 24)
  desktop-template Electron + SvelteKit template (excluded from CI)
  example/         Kubernetes manifest demo (excluded from CI)

packages/
  svelte/          @pandoks.com/svelte shared UI lib (workspace dep)
  postgres/        Patroni + PgBackRest + helm chart → ghcr.io image+chart
  valkey/          Valkey + Go reconciler + helm chart
  clickhouse/      ClickHouse + Keeper + backup + helm chart
  argocd/          ArgoCD CMP: kustomize-sst-render plugin

k3s/
  base/            Shared apps + core + monitoring kustomization
  bootstrap/       cert-manager, MetalLB, prometheus, haproxy, ArgoCD (prod)
  overlays/        local / dev / prod / cluster environment overrides
```

## SST topology

`sst.config.ts:35-49` imports every `infra/*.ts` module via literal
`await Promise.all([import('./infra/...')])` (dynamic imports break SST,
see `sst.config.ts:34`).

| Module                     | Provisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/utils.ts`           | Shared stage helpers (`isProduction`, `domain`, `EXAMPLE_DOMAIN`, `STAGE_NAME`) plus pure infrastructure render helpers. Use `isProduction` for the production split and read `$app.stage` directly for checks or commands that require the exact SST stage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `infra/dns.ts`             | Cloudflare zone/account lookup and automatic `StageName` secret synchronization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `infra/secrets.ts`         | All `sst.Secret`s in a nested namespace (`:3-88`). Flat PascalCase resource names. `setSecret()` at `:90`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `infra/api.ts`             | `apiRouter` (`:13`), `textFunction` aka `TextSms` (`:20`), `scheduleTextGroup` (`:45`), `NotionWebhookHandler` (`:61`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `infra/website.ts`         | `PersonalWebsite` Cloudflare Pages project (`:14`), prod-only block `:13-end`. `DevWebsite` SST DevCommand at `:4-11`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `infra/aws.ts`             | AWS provider helpers. `US_WEST_2_REGION` + `usWest2Provider` (`aws.Provider`, `:3-4`) for pinning resources to us-west-2 (consumed by `infra/runner/**` + the runner buckets); `defaultAwsRegion` from `aws.getRegion()` (`:6-7`), auto-synced into the `AwsRegion` secret via `setSecret()` (`:8-12`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `infra/storage.ts`         | `BackupBucket` on Cloudflare R2 (`:4`); `runnerCacheBucket`/`runnerArtifactsBucket` (`sst.aws.Bucket`, ids `RunnerCacheStore`/`RunnerArtifactsStore`, `:18, 26`) — AWS S3, pinned to **us-west-2** via `{ provider: usWest2Provider }` (co-located with the runners). `s3Endpoint` R2 host string (`:16`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `infra/cloudflare.ts`      | Cloudflare DNS and global traffic steering for OVH ingress origins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `infra/github.ts`          | OIDC AWS role (`:59`), prod-only action secrets, Tailscale CI OAuth (`:116`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `infra/tailscale.ts`       | Tailnet ACL — overwrites globally (`:14`), k8s operator OAuth (`:54`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `infra/kubernetes.ts`      | ArgoCD CMP IAM user (prod-only, `:4-50`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `infra/cluster/cluster.ts` | Config-driven independent OVH K3s clusters declared as free-form entries under the single US account. Each declared cluster owns its network, API endpoint, mixed Public Cloud/dedicated pools, and ingress LBs; Cloudflare aggregates public origins globally. Supporting modules own topology derivation, per-cluster networking, provider resources, and the shared host bootstrap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `infra/dev.ts`             | `sst.x.DevCommand` shortcuts for `dev:init`, `dev:destroy`, k3d restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `infra/runner/runner.ts`   | Nested non-sandbox module (imported at `sst.config.ts:48`). Ephemeral-EC2 job runner — launch (routed by `RUNNER_VARIANTS` `step.ts:11` across **x86 / arm64 / gpu-x86 / gpu-arm64**, spot/on-demand), `git clone` the repo, run an arbitrary `$.command` via SSM, always terminate (`infra/runner/step.ts`). Files `infra/runner/{runner,ami,step,types}.ts`, plus two non-`.ts` EC2 Image Builder component recipes: `ami.yaml` (`name: RunnerTools` `:1` — build-essentials/Node/AWS-CLI/uv) and `ami-gpu.yaml` (`name: RunnerGpuTools` `:1` — NVIDIA driver + CUDA, layered onto the base for GPU recipes, templated by `{{CUDA_ARCH}}`). The canonical precedent for a nested `infra/<feature>/<file>.ts` module (alongside `infra/cluster/cluster.ts`). Subsystem gotchas (layered AMIs, GPU bake on GPU instance, `$resolve` order, literal IDs) in `gotchas/runner.md`. |
| `infra/sandbox/`           | Empty (`.gitkeep`). Re-add per-experiment modules here and import them explicitly in `sst.config.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Data flows (one-liners)

- **Notion blog deploy**: Notion DB → `apps/web/scripts/notion.ts`
  downloads images + writes **`apps/web/src/lib/blog/*.json`** (+
  `src/lib/blog/images/`, `notion.ts:107-108, 271`) — NOT the route
  dir; `routes/blog/[title]/` holds only `+page.svelte` + `+page.ts`
  (the prerendered presentation, which reads the JSON via
  `import.meta.glob('/src/lib/blog/*.json')`). `vite build` prerenders
  via adapter-static; Vite plugin `hideBlogWhenEmpty()`
  (`apps/web/vite/plugins/hide-blog.ts`) skips the route when no posts.
  **Deploy is a Cloudflare Pages GitHub git-integration**
  (`infra/website.ts:14-34`: `source.type=github`,
  `productionBranch=main`, `pathIncludes apps/web/*`): Cloudflare runs
  `buildCommand` `pnpm --filter web build` on push to `main` — **SST
  provisions the Pages project but does NOT build/upload artifacts.**
  Full chain: Notion webhook → `NotionWebhookHandler` Lambda fans out
  `handleNotionBlogSync` → dispatches `sync-notion.yaml` (GitHub API) →
  PR on branch `auto/notion-sync` → merge to `main` → CF Pages git
  trigger rebuilds + deploys.
- **Notion webhook → SMS reminder**: `api.pandoks.com/notion/webhook` →
  HMAC-SHA256 verify (`webhook.ts:81-91`) →
  `Promise.allSettled([handleTextReminder, handleNotionBlogSync])`
  (`webhook.ts:95-98`) → upsert EventBridge `at(...)` schedules per
  `{pageId, phone}` → on trigger invoke `TextSms` Lambda → Twilio.
  Idempotent because `scheduleName()` is deterministic
  (`text-reminder.ts:22-26`) and create→ConflictException→update
  (`text-reminder.ts:50-72`).

For full per-flow traces, see `.claude/rules/gotchas/*.md`.

## State storage

| Where                                             | What                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cloudflare R2 `BackupBucket`                      | Patroni WAL + ClickHouse backups                                                                 |
| AWS SSM `/tmp/notion-verification-token`          | Transient Notion bootstrap, manually promoted                                                    |
| EventBridge Scheduler `text-scheduler[-dev]`      | Per-phone SMS reminder schedules (`infra/api.ts:45-47`)                                          |
| Notion blog DB `20f1bb259e4b804ba24be1ceebf4c761` | Blog source of truth (`infra/api.ts:9-11`, the `Notion` Linkable)                                |
| SST secrets                                       | All credentials in a nested namespace (`infra/secrets.ts`); `sst-env.d.ts` is the typed manifest |

## Cluster overview

- Topology lives in `infra/cluster/config.ts` as generic primitives.
  `PRODUCTION_CLUSTER_CONFIG` and `NON_PRODUCTION_CLUSTER_CONFIG` both currently
  declare zero clusters. A cluster is an array entry (`region`, `pools`), one
  per OVH datacenter (`region` is a datacenter code like `hil`/`vin`/`sgp`);
  each pool mixes OVH products via the `server`
  union (public-cloud vs dedicated) and carries raw Kubernetes labels/taints.
  When no clusters declare nodes, stale OVH cluster Tailnet entries for the
  stage are reclaimed.
- CI retains only the OVH credentials and runs the TypeScript topology
  contracts. Pulumi creates the Public Cloud project and passes its generated
  ID directly. Cluster resources use `protect: isProduction`, so production
  resources are protected and non-production resources are not.
- Everything runs under the single US OVH account: one stage project/vRack
  foundation. Each declared cluster has a separate single-region private
  network, subnet, gateway, K3s pod/service CIDRs, MetalLB range, token, and
  API DNS name — all derived from its region's `CLUSTER_NETWORK_INDEXES`
  entry (`10.<i>.0.0/16`, VLAN
  `<i>`, pods `10.<42+2i>`, MetalLB `10.<i>.200.x`). This keeps managed
  Gateway/LB usage within OVH's supported single-region network topology.
  Dedicated pools can opt into a shared cross-cluster interconnect VLAN
  (default 4000, `172.16.0.0/12`, node IPs `172.<16+i>.<pool>.<n>`) for
  private cross-region traffic such as database replication; Public Cloud
  instances cannot join it (single private NIC).
- HAProxy uses host ports 80/443 on nodes marked for public ingress. A single
  origin goes directly behind proxied Cloudflare DNS; multiple origins use the
  regional OVH LBs and one global Cloudflare Load Balancer.
- ArgoCD App-of-Apps `prod-cluster` (`k3s/overlays/prod/argocd.yaml:47-68`)
  watches `k3s/overlays/prod` via `kustomize-sst-render-v1.1`. The regional
  ConfigMap supplies `--region` so every independent cluster renders its own
  MetalLB range.

## Entry points (cheat sheet)

- **SST config**: `sst.config.ts:5` (app name), `:24-38` (infra imports).
- **HTTP**: `POST /notion/webhook` → `apps/functions/src/api/notion/webhook.ts:25`
  (`webhookHandler`). Notion blog-sync side-effect inside the webhook fan-out:
  `apps/functions/src/api/notion/gh-blog-sync.ts:7` (`handleNotionBlogSync`)
  fires a GitHub `workflow_dispatch` → `sync-notion.yaml`.
- **Background Lambda**: `TextSms` → `apps/functions/src/text.ts:6`
  (`sendTextHandler`). Invoked by EventBridge Scheduler entries written
  by the Notion webhook flow.
- **Cron**: EventBridge Scheduler group `text-scheduler[-dev]` →
  `infra/api.ts:45-47`.
- **Web build**: Vite plugin `hideBlogWhenEmpty()` at
  `apps/web/vite/plugins/hide-blog.ts` (registered in
  `apps/web/vite.config.ts:13`). Notion sync script
  `apps/web/scripts/notion.ts` runs on `sync-notion.yaml` workflow.
- **CLI**: `scripts/cluster/main.sh:18-35`. Subcommands: `k3d`
  (`scripts/cluster/k3d.sh:106`), `deploy` (`scripts/cluster/deploy.sh:128`).
- **ArgoCD root**: `Application/prod-cluster` at
  `k3s/overlays/prod/argocd.yaml:47-68`; CMP at
  `packages/argocd/argocd-plugin.yaml`.
