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

- **Dynamic imports break SST.** `sst.config.ts:35-49` keeps the literal
  `await Promise.all([import('./infra/...')])` list. The
  `// NOTE: for some reason, dynamic imports don't work well so just
manually import` comment at `sst.config.ts:34` is load-bearing.

## Tailscale ACL

- **`tailscale.Acl` overwrites globally.** `infra/tailscale.ts:14` sets
  `overwriteExistingContent: true` with an explicit warning at `:11-13`:
  a change rewrites the Tailnet ACL across **all** stages. Treat ACL
  edits as a global rollout. `resetAclOnDestroy: true` at
  `infra/tailscale.ts:10` compounds this — destroying the SST stage
  wipes the ACL too.

## Tailscale root OAuth client (tagless)

- **The provider authenticates as a manually-created OAuth client** —
  `TAILSCALE_OAUTH_CLIENT_ID`/`TAILSCALE_OAUTH_CLIENT_SECRET` env →
  `sst.config.ts:25-29`. It's the one credential IaC cannot create for
  itself (chicken-and-egg); made once in the admin console (Trust
  credentials → Credential → OAuth, scopes "All - Read & Write",
  no tags). The client secret never expires — do NOT replace it with an
  API access token, those hard-expire at ≤90 days and killed CI once
  (the diff-sst 401, 2026-07-11).
- **Tagless is deliberate and verified.** The tag-ownership rule
  ("created keys must carry tags owned by the credential's tags") is
  tied to tagged credentials; a tagless all-scope credential creates
  tagged keys/clients freely — verified empirically 2026-07-12 by
  creating + deleting a tagged (`tag:ovh`-style) auth key with it. If Tailscale
  ever tightens this and creations start 403ing on tags, recreate the
  credential via Custom scopes with a tag that `tagOwners` grants
  ownership of every IaC-managed tag.
- **Raw Tailscale API calls can't use the client secret directly** —
  exchange it first: `tailscaleApiToken` (`infra/tailscale.ts:88-111`)
  POSTs client credentials to `/api/v2/oauth/token` for a 1-hour Bearer
  token; `deleteTailscaleDevices` (`:111`) consumes it. Reuse that
  helper for any new direct `api.tailscale.com` call.
- **The same pair must be seeded as SST secrets**
  (`TailscaleOauthClientId`/`TailscaleOauthClientSecret`,
  `infra/secrets.ts:49-52`) for the hooks, AND lives in `.env.<stage>`
  for the provider — two plumbing paths, one credential.
  `infra/github.ts:133-142` mirrors the SST secrets into the GH action
  secrets CI reads.

## OVH cluster

- **Single-region by design.** The private network, subnet, gateway and
  load balancers are all pinned to one `REGION`
  (`infra/cluster/cluster.ts`). Multi-region requires multiple clusters +
  Cloudflare DNS steering.
- **The Public Cloud project remains required with dedicated compute.**
  `infra/cluster/network.ts` and `load-balancers.ts` use
  `OVH_CLOUD_PROJECT_SERVICE` for the vRack attachment, private network,
  subnet, gateway, load balancers, and floating IPs. Never remove the project
  as part of a compute-only migration.
- **Four independent pools are configured in `infra/cluster/cluster.ts`.**
  Dedicated plan, datacenter, order-region, and option values must be validated
  against the live authenticated catalog, then reviewed in an authenticated
  preview before a non-zero dedicated count is committed or applied. The exact
  preview, scale, migration, drain, and recovery procedure is
  `infra/cluster/README.md`.
- **Downsizing is highest-index and two-deploy only.** Derive the `count - 1`
  hostname/logical name from `infra/cluster/README.md`. For a control plane:
  snapshot, verify membership/endpoint health from a survivor, drain, stop k3s
  on the target, remove its exact etcd member, delete the Kubernetes node, and
  re-check odd quorum. Then deploy once with counts unchanged and
  `OVH_UNPROTECTED_NODE_LOGICAL_NAME` set to that exact highest-index logical
  name; reduce that pool by one in a second deploy; clear the override.
- **Production bootstrap inputs are immutable for existing machines.**
  Public Cloud `userData` and dedicated reinstall customization are ignored.
  Rebuild one node at a time; never force a dedicated reinstall to roll out
  `infra/cluster/bootstrap.sh`.
- **No provider SSH keys.** Administrator SSH uses Tailscale only, cluster
  traffic uses vRack, and the OVH console/rescue environment is the fallback.
- **Tailnet reclaim when total count is zero.**
  `infra/cluster/cluster.ts` deletes stale devices tagged `tag:ovh`,
  `tag:<stage>`, and a cluster role. Per-node deletion is handled by
  `DeleteServerFromTailnet` in `infra/cluster/bootstrap.ts`.

## TLS / Cloudflare origin cert

- **CSR is generated locally** in `infra/cloudflare.ts`. When
  `infra/cluster/cluster.origin.<stage>.csr` is missing, the file is recreated
  via `execFileSync('openssl', [...])`. The key is piped into
  `sst secret set` via `/bin/sh -lc`
  (stdin redirect, `< keyPath`); the cert later goes in via a heredoc
  (`<<'EOF' ... EOF`). Never as a process arg. The CSR + key
  paths are stage-suffixed: `cluster.origin.dev.csr` and
  `cluster.origin.prod.csr` already exist in `infra/cluster/`. **Don't
  delete those files casually.**

## Protection

- **Production resources are `protect: true`** (`sst.config.ts:7`). OVH
  cluster compute remains protected unless the exact single-node
  `OVH_UNPROTECTED_NODE_LOGICAL_NAME` matches the current highest index in its
  pool. Both the dedicated server and its reinstall task use that same
  protection decision. There is no wildcard or all-node bypass.

## SST refresh exit code

- **`sst refresh` exit-code bug.**
  `.github/workflows/deploy-infra.yaml:93-97` carries
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
  `:103-105` deploy-kubernetes) — concurrent deploys queue, don't cancel.
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
