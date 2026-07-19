---
paths:
  - 'infra/**'
  - 'sst.config.ts'
  - 'sst-env.d.ts'
---

# Code style — Infra (SST / Pulumi)

How to add or modify resources in `infra/*.ts` and `sst.config.ts`.

## Import pattern

- Every `infra/**/*.ts` file imports `{ secrets } from './secrets'` (or
  `'../secrets'` when nested a level deeper), then opts into the namespace
  it needs (`infra/api.ts:1`, `infra/tailscale.ts:2`,
  `infra/kubernetes.ts:2`, `infra/cloudflare.ts:6`, `infra/github.ts:2`).

## Stage gating

- **`if (isProduction) { new Resource(...) }`** — dev stages skip
  prod-only wiring. Examples: `infra/website.ts:13` (PersonalWebsite
  Pages project), `infra/kubernetes.ts:4` (ArgoCD CMP user),
  `infra/github.ts:21` (OIDC + most CI secrets),
  `infra/cloudflare.ts:16` (dev-only example.pandoks.com DNS records).
  Note: `NotionWebhookHandler` (`infra/api.ts:61`) is **unconditional**
  — not a prod-only example, deploys in every stage.
- **Sandbox imports go in the literal `Promise.all` list** at
  `sst.config.ts:35-49`. When re-adding sandbox files under
  `infra/sandbox/<name>.ts`, gate **inside** the sandbox file with
  `if ($app.stage === 'pandoks') { ... }` rather than at the
  `sst.config.ts` import site — keeps the import list literal
  (dynamic imports break SST per `sst.config.ts:34`).

## Region / non-default provider override

- **App default region is `us-west-1`** (`sst.config.ts:11`, the `aws`
  provider block). Resources land there unless explicitly handed a
  different provider.
- **To pin a resource to another region, pass `{ provider: usWest2Provider }`
  as the 3rd constructor arg** — the shared `aws.Provider` is defined once in
  `infra/aws.ts:4` (`usWest2Provider`, region `US_WEST_2_REGION` `:3`) and
  imported where needed. Don't `new aws.Provider(...)` per file — reuse the
  `infra/aws.ts` export (single declaration, same rule as
  "Cross-file SST resource sharing" below).
- **Both raw Pulumi resources and SST components take it the same way.**
  Every resource in `infra/runner/runner.ts` + `infra/runner/ami.ts` passes
  `{ provider: usWest2Provider }`; the two `sst.aws.Bucket`s in
  `infra/storage.ts:18, 26` pass it as the component's `opts` (3rd arg) — SST
  forwards it to the child `aws.s3.Bucket`, which inherits the provider via
  `{ parent }`. So the runner buckets physically live in us-west-2,
  co-located with the runners.
- **S3 buckets are region- and name-immutable.** Changing a bucket's region
  (or hardcoded name) forces a destroy+recreate, and `sst.aws.Bucket`
  hardcodes `forceDestroy: true` — so a naive region change **deletes the
  data**. Migrate by: back up to a holding bucket → deploy (creates new
  bucket, drops old) → restore → verify object counts → delete holding.

## Secret-drift auto-set helper

- **`setSecret()` at `infra/secrets.ts:90`.** Pattern:

  ```ts
  secrets.X.value.apply((current) => {
    if (current !== desired) setSecret(secrets.X.name, desired);
  });
  ```

- Real usages: `infra/dns.ts:11-15` for `StageName`,
  `infra/aws.ts:8-12` for `AwsRegion`,
  `infra/tailscale.ts:63-91` for the k8s-operator OAuth client,
  `infra/kubernetes.ts:38-50` for ArgoCD AWS creds.
- **Prefer `$resolve([...]).apply(...)` over chained `.apply`** when
  multiple outputs need to settle together —
  `infra/tailscale.ts:63-91`, `infra/kubernetes.ts:38-50`,
  `infra/cloudflare.ts:79-87`.

## Secret naming

- **Nested namespace in `infra/secrets.ts` but flat PascalCase resource
  names**: `secrets.k8s.main.mainPostgres.SuperuserPassword` → resource
  ID `MainMainPostgresSuperuserPassword` (`infra/secrets.ts:69-71`).
  The naming convention is captured in a load-bearing inline comment at
  `infra/secrets.ts:69`.
- **Pattern (k8s subtree only)**: `<namespace><db-name><resource><var>`.
  Outside `secrets.k8s.*`, top-level secrets in flat namespaces
  (`notion`, `personal`, `twilio`, `oxylabs`, `ovh`, `tailscale`,
  `cloudflare`, `github`, `aws`) use **bare PascalCase resource names**
  without the namespace prefix: `KwokPhoneNumber`, `NotionApiKey`,
  `TwilioPhoneNumber`, `OvhApplicationSecret`. The k8s tree adds the prefix
  because two databases (`mainPostgres`, `mainValkey`,
  `mainClickhouse`) share property names like `AdminPassword`.
- **A brand-new non-derived `sst.Secret` must be seeded once** via
  `pnpm sst secret set <Name> --stage <stage>` (or an `.env.<stage>`
  entry) BEFORE the first deploy — only `setSecret()`-driven values
  auto-populate. A new secret with no value fails the deploy.
- A new top-level `infra/<feature>.ts` is **auto-covered** by the
  existing `infra/**` paths filter (`deploy-infra.yaml:8, 54`,
  `checks.yaml:78`) — no workflow glob edit needed when adding one.

## Resource ID + stage naming

- **SST resource string IDs are PascalCase**: `ApiRouter`,
  `NotionWebhookHandler`, `TextSms`, `ScheduleTextGroup`,
  `ScheduleInvokeTextRole`, `OvhK3sPrivateNetwork`,
  `OvhOriginCloudflareCaCertificate` (aliased from
  `HetznerOriginCloudflareCaCertificate`).
- **Stage names lowercase**: `production`, `pandoks`. `STAGE_NAME`
  derives to `'prod'` / `'dev'` (`infra/dns.ts:9`). Inside CI, the
  `SST_STAGE` env defaults to `'production'`
  (`.github/workflows/deploy-infra.yaml:39`).

## OVH hybrid cluster

- **Topology and four independent pools live in
  `infra/cluster/cluster.ts`.** Host hardening and k3s setup live in
  `infra/cluster/bootstrap.sh`; scale, migration, drain, reinstall-safety, and
  recovery procedures live in `infra/cluster/README.md`.
- **The Public Cloud project is permanent shared infrastructure.**
  `ovh.cloudproject.Project` creates it, and its `projectId` is passed directly
  to the vRack project attachment, private network, subnet, gateway, and load
  balancers even when all compute is dedicated. Production deletion protection
  must remain enabled.
- **The vRack `/24` has fixed owners.** Neutron/DHCP owns `.2-.99`, MetalLB
  owns `.100-.149`, dedicated control planes own `.150-.199`, and dedicated
  workers own `.200-.254`. Change `CLUSTER_ADDRESS_PLAN`, the subnet, MetalLB,
  monitoring endpoints, and their contract tests together.
- **Origin TLS keeps its deployed legacy identities.**
  `secrets.k8s.OriginTlsKey` and `.OriginTlsCrt` deliberately create
  `HetznerOriginTlsKey` and `HetznerOriginTlsCrt`; the OVH-named Cloudflare
  certificate aliases `HetznerOriginCloudflareCaCertificate`. This reuses the
  active secret values and certificate across the provider migration.
- **Never enable a dedicated pool from copied catalog values.** Validate its
  plan, datacenter, order region, and required options against the live
  authenticated OVH cart, then set the intended count locally and review an
  authenticated `sst diff` before committing or applying it.
- **Cluster hosts have no provider SSH key.** Administrator access is Tailscale
  SSH only; cluster traffic stays on vRack and console/rescue is the recovery
  path. Production bootstrap inputs are immutable for existing nodes, so never
  force a dedicated reinstall to roll out `bootstrap.sh`.
- **Cluster protection is stage-only.** Cluster resources use
  `protect: isProduction`: every production node is protected and every
  non-production node is unprotected. There is no environment-variable bypass.
  Production scale-down requires a separate reviewed IaC change scoped to the
  exact derived highest-index resource.
- The dev VPS-4 subscription is an SST resource only in the `pandoks` stage and
  is not cluster capacity. Its guest setup remains manual; follow
  `scripts/dev-vps/README.md`.

## Subprocess IaC

- **`execSync` / `execFileSync` for sub-process effects**:
  - `setSecret()` shells out to `sst secret set` (`infra/secrets.ts:92`).
  - `infra/cloudflare.ts:36-81` shells out to `openssl` to generate the
    CSR, then `execFileSync('/bin/sh', ['-lc', 'sst secret set ... < <keyfile>'])`
    pipes the private key into `sst secret set` via stdin redirection
    rather than passing it as a process arg.

## Cron / scheduled Lambdas

- Use `sst.aws.CronV2` for time-based triggers (not the deprecated
  `sst.aws.Cron`). Schedule strings are AWS EventBridge format: `rate(5
minutes)` for fixed intervals, `cron(M H D-of-M M D-of-W Y)` (with `?`
  for one of the two day slots) for calendar time, all in UTC.
- For a stage-gated cron, wrap the **entire `sst.aws.CronV2`** in the
  `if (isProduction) { ... }` or `if ($app.stage === 'pandoks') { ... }`
  guard. Put the cron file under `infra/<feature>.ts` (or
  `infra/sandbox/<feature>.ts` for pandoks-only experiments) and add it
  to the `Promise.all` list in `sst.config.ts:35-49`.
- Cron handlers are Lambdas, so the cron file should hold the
  `sst.aws.Function` + `sst.aws.CronV2` pair, not the handler code.
  Handler implementation lives under `apps/functions/src/` (see
  Lambda-handler placement below).

## Cross-file SST resource sharing

- **Define each SST resource exactly once.** `new sst.Linkable('Notion',
…)` at `infra/api.ts:9-11` is the single declaration of the `Notion`
  Linkable. To use it from another infra file, `export` it from
  `api.ts` and `import` it — do NOT re-instantiate (collides on the
  resource ID).
- `infra/api.ts` already exports `nodeVersion` and `apiRouter` for this
  reason (`infra/api.ts:6, 13`). Follow the same pattern when sharing a
  function ARN, secret, or other resource.

## Dynamic-import constraint

- **`sst.config.ts:35-49` MUST keep the literal `await Promise.all([import('./infra/...')])`
  list**. Dynamic-string imports break SST. The `// NOTE: for some
reason, dynamic imports don't work well so just manually import`
  comment at `:34` is load-bearing.
