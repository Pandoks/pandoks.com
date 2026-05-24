# Architecture (overview)

Always-loaded. High-level topology so future sessions know what exists where.
Area-specific architecture details live in `.claude/rules/gotchas/*.md` and
`.claude/rules/conventions/*.md`.

Single SST 4 app (`sst.config.ts:5`, `name: 'personal'`) drives AWS,
Cloudflare, Hetzner, GitHub, Tailscale. Two stages: `production` and
`pandoks` (per-user dev).

`infra/sandbox/` and `apps/functions/src/sandbox/` exist as `.gitkeep`-only
scaffolding — the apartment-scraper experiment lived here until it was
removed. Future sandbox modules should be imported from `sst.config.ts`
the same way `infra/sandbox/apartment-search.ts` used to be (literal
`import('./infra/sandbox/<name>')` in the `Promise.all` at `:23-34`),
with stage gating *inside* the sandbox file rather than at the import
site.

## Layering

```
sst.config.ts ─┬─ infra/*.ts                 IaC: AWS, CF, GH, Hetzner, Tailscale
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

`sst.config.ts:23-34` imports every `infra/*.ts` module via literal
`await Promise.all([import('./infra/...')])` (dynamic imports break SST,
see `sst.config.ts:22`).

| Module                | Provisions                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/dns.ts`        | CF zone lookup, exports `domain`, `STAGE_NAME`, `isProduction` (`:3-9`). Auto-sets `Stage`/`AwsRegion` secrets via `setSecret()`.       |
| `infra/secrets.ts`    | All `sst.Secret`s in a nested namespace (`:3-79`). Flat PascalCase resource names. `setSecret()` at `:81`.                              |
| `infra/api.ts`        | `apiRouter` (`:13`), `textFunction` aka `TextSms` (`:20`), `scheduleTextGroup` (`:45`), `NotionWebhookHandler` (`:61`).                 |
| `infra/website.ts`    | `PersonalWebsite` Cloudflare Pages project (`:14`), prod-only block `:13-end`. `DevWebsite` SST DevCommand at `:4-11`.                  |
| `infra/storage.ts`    | `BackupBucket` on Cloudflare R2.                                                                                                        |
| `infra/cloudflare.ts` | Origin TLS cert for Hetzner (15-year validity, `:74-82`). LB DNS records (dev only, `:16-37`).                                          |
| `infra/github.ts`     | OIDC AWS role (`:59`), prod-only action secrets, Tailscale CI OAuth (`:110`).                                                           |
| `infra/tailscale.ts`  | Tailnet ACL — overwrites globally (`:14`), k8s operator OAuth (`:54`).                                                                  |
| `infra/kubernetes.ts` | ArgoCD CMP IAM user (prod-only, `:4-50`).                                                                                               |
| `infra/vps/vps.ts`    | Hetzner network, firewall, k3s nodes — counts currently 0 (`:9, 11`); tail (`:131-164`) reclaims orphaned Tailnet entries when sum==0.  |
| `infra/dev.ts`        | `sst.x.DevCommand` shortcuts for `dev:init`, `dev:destroy`, k3d restart.                                                                |
| `infra/sandbox/`      | Empty (`.gitkeep`). Re-add per-experiment modules here and import them explicitly in `sst.config.ts`.                                   |

## Data flows (one-liners)

- **Notion blog deploy**: Notion DB → `apps/web/scripts/notion.ts`
  downloads images + writes `apps/web/src/routes/blog/[title]/` files →
  `vite build` (prerenders via adapter-static; Vite plugin
  `hideBlogWhenEmpty()` at `apps/web/vite/plugins/hide-blog.ts` skips
  the dynamic route if no posts yet) → Cloudflare Pages. The Notion
  webhook (`NotionWebhookHandler` Lambda) fans out `handleNotionBlogSync`
  which dispatches `sync-notion.yaml` via GitHub API on Notion changes.
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

| Where                                             | What                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Cloudflare R2 `BackupBucket`                      | Patroni WAL + ClickHouse backups                                                                      |
| AWS SSM `/tmp/notion-verification-token`          | Transient Notion bootstrap, manually promoted                                                         |
| EventBridge Scheduler `text-scheduler[-dev]`      | Per-phone SMS reminder schedules (`infra/api.ts:45-47`)                                               |
| Notion blog DB `20f1bb259e4b804ba24be1ceebf4c761` | Blog source of truth (`infra/api.ts:9-11`, the `Notion` Linkable)                                     |
| SST secrets                                       | All credentials in a nested namespace (`infra/secrets.ts`); `sst-env.d.ts` is the typed manifest      |

## Cluster overview

- Both `CONTROL_PLANE_NODE_COUNT` and `WORKER_NODE_COUNT` are `0`
  (`infra/vps/vps.ts:9, 11`). When sum is 0, `vps.ts:131-164` reclaims any
  Tailnet entries tagged `tag:k8s` + `tag:<stage>`.
- HAProxy ingress on `NodePort 30443` (CF → LB → node) with proxy-protocol on.
- ArgoCD App-of-Apps `prod-cluster` (`k3s/overlays/prod/argocd.yaml:47-68`)
  watches `k3s/overlays/prod` via `kustomize-sst-render-v1.0` CMP, which runs
  `./scripts/cluster/main.sh deploy prod --dry-run --quiet` inside the
  repo-server pod.

## Entry points (cheat sheet)

- **SST config**: `sst.config.ts:5` (app name), `:23-34` (infra imports).
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
  (`scripts/cluster/k3d.sh:111`), `deploy` (`scripts/cluster/deploy.sh:128`).
- **ArgoCD root**: `Application/prod-cluster` at
  `k3s/overlays/prod/argocd.yaml:47-68`; CMP at
  `packages/argocd/argocd-plugin.yaml`.
