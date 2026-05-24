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
  `sst.config.ts:23-34`. When re-adding sandbox files under
  `infra/sandbox/<name>.ts`, gate **inside** the sandbox file with
  `if ($app.stage === 'pandoks') { ... }` rather than at the
  `sst.config.ts` import site — keeps the import list literal
  (dynamic imports break SST per `sst.config.ts:22`).

## Secret-drift auto-set helper

- **`setSecret()` at `infra/secrets.ts:81`.** Pattern:

  ```ts
  secrets.X.value.apply((current) => {
    if (current !== desired) setSecret(secrets.X.name, desired);
  });
  ```

- Real usages: `infra/dns.ts:11-15` for `StageName`,
  `infra/dns.ts:22-27` for `AwsRegion`,
  `infra/tailscale.ts:63-91` for the k8s-operator OAuth client,
  `infra/kubernetes.ts:38-50` for ArgoCD AWS creds.
- **Prefer `$resolve([...]).apply(...)` over chained `.apply`** when
  multiple outputs need to settle together —
  `infra/tailscale.ts:63-91`, `infra/kubernetes.ts:38-50`,
  `infra/cloudflare.ts:85-93`.

## Secret naming

- **Nested namespace in `infra/secrets.ts` but flat PascalCase resource
  names**: `secrets.k8s.main.mainPostgres.SuperuserPassword` → resource
  ID `MainMainPostgresSuperuserPassword` (`infra/secrets.ts:61-67`).
  The naming convention is captured in a load-bearing inline comment at
  `infra/secrets.ts:60`.
- **Pattern (k8s subtree only)**: `<namespace><db-name><resource><var>`.
  Outside `secrets.k8s.*`, top-level secrets in flat namespaces
  (`notion`, `personal`, `twilio`, `oxylabs`, `hetzner`, `tailscale`,
  `cloudflare`, `github`, `aws`) use **bare PascalCase resource names**
  without the namespace prefix: `KwokPhoneNumber`, `NotionApiKey`,
  `TwilioPhoneNumber`, `HetznerApiKey`. The k8s tree adds the prefix
  because two databases (`mainPostgres`, `mainValkey`,
  `mainClickhouse`) share property names like `AdminPassword`.

## Resource ID + stage naming

- **SST resource string IDs are PascalCase**: `ApiRouter`,
  `NotionWebhookHandler`, `TextSms`, `ScheduleTextGroup`,
  `ScheduleInvokeTextRole`, `HetznerInboundFirewall`,
  `HetznerOriginCloudflareCaCertificate`.
- **Stage names lowercase**: `production`, `pandoks`. `STAGE_NAME`
  derives to `'prod'` / `'dev'` (`infra/dns.ts:9`). Inside CI, the
  `SST_STAGE` env defaults to `'production'`
  (`.github/workflows/deploy-infra.yaml:39`).

## Subprocess IaC

- **`execSync` / `execFileSync` for sub-process effects**:
  - `setSecret()` shells out to `sst secret set` (`infra/secrets.ts:83`).
  - `infra/cloudflare.ts:44-92` shells out to `openssl` to generate the
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
  to the `Promise.all` list in `sst.config.ts:23-34`.
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

- **`sst.config.ts:22-34` MUST keep the literal `await Promise.all([import('./infra/...')])`
  list**. Dynamic-string imports break SST. The `// NOTE: for some
  reason, dynamic imports don't work well so just manually import`
  comment at `:22` is load-bearing.
