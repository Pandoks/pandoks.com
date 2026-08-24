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

- **Dynamic imports break SST.** `sst.config.ts:30-44` keeps the literal
  `await Promise.all([import('./infra/...')])` list. The
  `// NOTE: for some reason, dynamic imports don't work well so just
manually import` comment at `sst.config.ts:29` is load-bearing.

## Tailscale ACL

- **`tailscale.Acl` overwrites globally.** `infra/tailscale.ts:14` sets
  `overwriteExistingContent: true` with an explicit warning at `:11-13`:
  a change rewrites the Tailnet ACL across **all** stages. Treat ACL
  edits as a global rollout. `resetAclOnDestroy: true` at
  `infra/tailscale.ts:10` compounds this — destroying the SST stage
  wipes the ACL too.

## Tailscale root OAuth client (tagless)

- **The provider authenticates as a manually-created OAuth client** —
  `TAILSCALE_OAUTH_CLIENT_ID`/`TAILSCALE_OAUTH_CLIENT_SECRET` env, read
  by the provider itself (`sst.config.ts:24` pins the version only).
  It's the one credential IaC cannot create for
  itself (chicken-and-egg); made once in the admin console (Trust
  credentials → Credential → OAuth, scopes "All - Read & Write",
  no tags). The client secret never expires — do NOT replace it with an
  API access token, those hard-expire at ≤90 days and killed CI once
  (the diff-sst 401, 2026-07-11).
- **Tagless is deliberate and verified.** The tag-ownership rule
  ("created keys must carry tags owned by the credential's tags") is
  tied to tagged credentials; a tagless all-scope credential creates
  tagged keys/clients freely — verified empirically 2026-07-12 by
  creating + deleting a `tag:hetzner` auth key with it. If Tailscale
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
  `infra/github.ts:117-126` mirrors the SST secrets into the GH action
  secrets CI reads.

## OVH dev box

- **Credentials arrive on two channels, and the config key is a trap.**
  `sst.config.ts:18-23` carries only the non-secret halves (`endpoint`,
  `applicationKey`) and needs `package: '@ovhcloud/pulumi-ovh'` for them to
  land in the `ovh:` namespace the provider actually reads; the secret pair
  comes from the `OVH_APPLICATION_SECRET` / `OVH_CONSUMER_KEY` env vars
  (`.env.example:10-11` locally, `deploy-infra.yaml:74-75` in CI, mirrored
  into GitHub by `infra/github.ts:60-70`). Two failure signatures when the
  key is wrong: `both application_key and application_secret must be given`
  (config emitted under `@ovhcloud/pulumi-ovh:`, provider read `ovh:`) and
  `provider ovh not found` (bare `ovh:` key with no `package` field). Full
  reasoning in `conventions/infra.md`.
- **The "dev box" is prod-only.** `infra/dev.ts:3` gates it on
  `isProduction`, so it exists in `production` and nowhere else — the
  `pandoks` dev stage gets no VPS. It replaced a
  `$app.stage === 'pandoks'` `hcloud.Server` dev box, deleted along with
  `infra/dev-cloud-config.yaml`; don't resurrect that. `renderCloudInit`
  (`infra/utils.ts:1`) now has exactly one consumer,
  `infra/vps/servers.ts:173`.
- **`ovh.vps.Vps` has no userData/cloud-init field** — guest setup is
  manual, unlike the Hetzner nodes. `doNotSendPassword: false`
  (`infra/dev.ts:8`) is the provider default spelled out: OVH sets a root
  password and emails it. Swapping to key-based bootstrap means
  `publicSshKey`, which the provider requires be paired with `imageId` —
  and `imageId` doubles as the reinstall trigger, so it is not a drop-in
  addition to a live box.
- **Order shape lives in `plans`/`planOptions`, not top-level fields.**
  Datacenter and OS are `{ label, value }` configuration pairs inside the
  plan (`infra/dev.ts:16-19`: `vps_datacenter` `US-WEST-OR`, `vps_os`
  `Ubuntu 26.04`), and each option (`option-linux`, auto-backup, local
  storage, additional disk) is its own entry (`infra/dev.ts:22-47`). The
  original three are `duration: 'P1M'` + `pricingMode: 'upfront12'` — a
  prepaid year, which is why the resource carries `protect: true`
  (`infra/dev.ts:50`) and destroy fails by design.
- **The additional disk is ordered by hand in the Control Panel and only
  documented in code.** `plan_options` is ForceNew upstream
  (terraform-provider-ovh `ovh/order.go`) and the resource's `Update()` has
  no ordering path, so any diff on `planOptions` would replace the protected,
  prepaid VPS — hence `'planOptions'` in `ignoreChanges`
  (`infra/dev.ts:49-52`). The `option-additional-disk-2027-200g` entry uses
  `pricingMode: 'default'` because addon options carry no prepay discount
  across any pricing mode (verified in the OVH order catalog).

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
  `.github/workflows/deploy-infra.yaml:91-95` carries
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
  `:101-103` deploy-kubernetes) — concurrent deploys queue, don't cancel.
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
