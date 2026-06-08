---
paths:
  - 'infra/**'
  - 'sst.config.ts'
  - 'sst-env.d.ts'
  - '.github/workflows/deploy-infra.yaml'
  - '.github/workflows/sync-notion.yaml'
---

# Gotchas — infra/ + SST

## Dynamic imports

- **Dynamic imports break SST.** `sst.config.ts:24-38` keeps the literal
  `await Promise.all([import('./infra/...')])` list. The
  `// NOTE: for some reason, dynamic imports don't work well so just
manually import` comment at `sst.config.ts:22` is load-bearing.

## Tailscale ACL

- **`tailscale.Acl` overwrites globally.** `infra/tailscale.ts:14` sets
  `overwriteExistingContent: true` with an explicit warning at `:11-13`:
  a change rewrites the Tailnet ACL across **all** stages. Treat ACL
  edits as a global rollout. `resetAclOnDestroy: true` at
  `infra/tailscale.ts:10` compounds this — destroying the SST stage
  wipes the ACL too.

## Hetzner cluster

- **Single-region by design.** Networks are region-locked
  (`infra/vps/vps.ts:24-35`). Multi-region requires multiple clusters +
  Cloudflare DNS steering.
- **Servers can only be upsized.** `infra/vps/vps.ts:13` — disk size must
  monotonically grow. The constraint NOTE lives in `vps.ts`, but the
  actual `hcloud.Server` resource (its `serverType`/`image`/`location`)
  is built in the sibling `infra/vps/servers.ts:182-188` by
  `createServers()` (`:55`); that file also owns the
  `DeleteServerFromTailnet` `$util.ResourceHook` (`:10`) that reclaims a
  destroyed node's Tailnet entry, and reads `infra/vps/cloud-config.yaml`
  (`:7`). But the literal VALUES are stage-switched module consts back in
  `vps.ts` — `SERVER_TYPE` (`vps.ts:14`, `ccx13` prod / `cx23` dev),
  `SERVER_IMAGE` (`:18`, `ubuntu-24.04`), `LOCATION` (`:19`, `hil` prod /
  `fsn1` dev) — passed into `createServers()` at `vps.ts:106-108, 123-125`.
  So: change the resource SHAPE in `servers.ts`, change the type/image/
  region VALUES in `vps.ts`.
- **Downsizing requires manual drain.** `infra/vps/vps.ts:8`: must
  `kubectl drain && kubectl delete node` first. Pulumi scaling node count
  down does not drain k8s.
- **Tailnet reclaim when count==0.** `infra/vps/vps.ts:131-164`
  auto-deletes Tailscale devices tagged `tag:k8s` + `tag:<stage>` when both
  `CONTROL_PLANE_NODE_COUNT + WORKER_NODE_COUNT == 0`. Bumping counts will
  bring the cluster up — but ArgoCD App-of-Apps then takes over.
- **Current counts are 0** in both stages (`infra/vps/vps.ts:9, 11`).

## TLS / Cloudflare origin cert

- **CSR is generated locally** in `infra/cloudflare.ts:45-62`. When
  `infra/vps/vps.origin.<stage>.csr` is missing, the file is recreated
  via `execFileSync('openssl', [...])`. The key is piped into
  `sst secret set` via `/bin/sh -lc` at `infra/cloudflare.ts:63-69`
  (stdin redirect, `< keyPath`); the cert later goes in via `:85-93`
  (heredoc, `<<'EOF' ... EOF`). Never as a process arg. The CSR + key
  paths are stage-suffixed: `vps.origin.dev.csr` and
  `vps.origin.prod.csr` already exist in `infra/vps/`. **Don't delete
  those files casually.**

## Protection

- **Production resources are `protect: true`** (`sst.config.ts:7`). Hetzner
  servers also set `protect: isProduction`. Delete fails by design.

## SST refresh exit code

- **`sst refresh` exit-code bug.**
  `.github/workflows/deploy-infra.yaml:98-102` carries
  `continue-on-error: true` with a `# TODO` link to
  `https://github.com/anomalyco/sst/issues/6713`. Don't replicate in
  other jobs.

## Sandbox gate (pattern, not active)

- `infra/sandbox/` and `apps/functions/src/sandbox/` are `.gitkeep`-only
  placeholders. When re-adding an experiment, **gate inside the sandbox
  file** with `if ($app.stage === 'pandoks') { ... }` rather than at the
  `sst.config.ts` import site — keeps the import list literal and
  satisfies the dynamic-import constraint above. Resources OUTSIDE the
  gate (e.g., a DynamoDB table you want available in prod for debugging)
  deploy everywhere; resources inside deploy only in `pandoks`.

## CI concurrency

- **Deploy jobs use `cancel-in-progress: false`**
  (`.github/workflows/deploy-infra.yaml:62-64` deploy-sst,
  `:108-110` deploy-kubernetes) — concurrent deploys queue, don't cancel.
- **Notion blog rebuild via `sync-notion.yaml`**, not a separate
  `deploy-web.yaml`. The `NotionWebhookHandler` Lambda fans out to
  `handleNotionBlogSync` (`apps/functions/src/api/notion/gh-blog-sync.ts:7`)
  which calls GitHub `workflow_dispatch` for `sync-notion.yaml`.

## Auto-generated typings

- **`sst-env.d.ts` is auto-generated.** Excluded from Prettier in
  `.prettierignore:12` but the project-root copy IS committed for Lambda
  typecheck. Don't edit by hand. Per-app copies also exist
  (`apps/functions/sst-env.d.ts`, `packages/argocd/sst-env.d.ts`) — same
  rule applies.
