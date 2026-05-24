---
paths:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.js'
  - '**/*.mjs'
---

# Code style — TypeScript / JavaScript

Taste rules that survive `prettier --check`. Lint-mechanical surface is in
`universal.md`.

## Naming

- Variables/functions: `camelCase`.
- Types/interfaces/classes: `PascalCase`, no `I`-prefix. Real examples:
  `NotionWebhookEvent` at
  `apps/functions/src/api/notion/webhook.ts:10`, `Users` exported type
  alias at `apps/functions/src/lib/pii.ts:8`.
- **Module-scope constants in `SCREAMING_SNAKE_CASE`** — used for both
  config-like values and sentinels. Real examples:
  `ALL_PHONE_NUMBERS`, `NAME_PROPERTY_KEYS`, `ONE_MINUTE`
  (`apps/functions/src/api/notion/text-reminder.ts:17, 18, 20`);
  `PHONE_NUMBER_MAPPINGS` (`apps/functions/src/lib/pii.ts:3`);
  `FONTS` consumed at `apps/web/src/routes/+layout.svelte:8`.
- **Module-scope clients/singletons in lowercase**: `notion`,
  `schedulerClient`, `twilioClient`, `ssmClient`
  (`apps/functions/src/api/notion/text-reminder.ts:15-16`,
  `apps/functions/src/text.ts:4`,
  `apps/functions/src/api/notion/webhook.ts:8`).
- **Booleans prefix-style**: `isProduction` (`infra/dns.ts:3`),
  `isFullPage` from `@notionhq/client`, `hasPosts` from
  `apps/web/vite/globals`.
- **Lambda handlers named `<verb>Handler`**:
  `sendTextHandler` (`apps/functions/src/text.ts:6`),
  `webhookHandler` (`apps/functions/src/api/notion/webhook.ts:25`).
- **Webhook handler-fanout functions named `handle<Noun>`** (not
  `*Handler`, because they're not Lambda entry points):
  `handleNotionBlogSync`
  (`apps/functions/src/api/notion/gh-blog-sync.ts:7`),
  `handleTextReminder`
  (`apps/functions/src/api/notion/text-reminder.ts:75`).
- **Discriminated-union literals are `snake_case`**: Notion events
  `'page.properties_updated' | 'page.created' | 'page.deleted'`
  (`apps/functions/src/api/notion/text-reminder.ts:78, 156`).
- **SST resource string IDs are `PascalCase`**: `ApiRouter`, `TextSms`,
  `NotionWebhookHandler`, `ScheduleTextGroup`,
  `ScheduleInvokeTextRole`, `ScheduleInvokeTextPolicy`
  (`infra/api.ts:13, 20, 35, 45, 49, 61`).

## Function shape

- **Exported Lambda handlers default to arrow form**:
  `export const webhookHandler = async (event) => { ... }`
  (`apps/functions/src/api/notion/webhook.ts:25`),
  `export const sendTextHandler = async (...) => { ... }`
  (`apps/functions/src/text.ts:6`),
  `export const handleNotionBlogSync = async (event) => { ... }`
  (`apps/functions/src/api/notion/gh-blog-sync.ts:7`).
- **Internal helpers prefer `function` declarations** for hoisting and a
  visual break between API and internals: `function scheduleName`,
  `async function upsertSchedule`
  (`apps/functions/src/api/notion/text-reminder.ts:22, 28`),
  `export async function handleTextReminder`
  (`:76` — note: exported fan-out helpers use `function`, not arrow).
  Counter-example: `const deleteSchedule = async (...) => { ... }` at
  `apps/functions/src/api/notion/text-reminder.ts:163` — drift, not a
  rule violation, but new code should follow the dominant pattern.
- **Public/exported functions get explicit return types** when
  meaningful (`upsertSchedule(...): Promise<void>` at
  `apps/functions/src/api/notion/text-reminder.ts:33`,
  `handleTextReminder(body): Promise<void>` at `:75`). Internal helpers
  rely on inference.
- **Early returns for guards**, no `else` after a return. See
  `apps/functions/src/api/notion/webhook.ts:27-38` (cascade of guard
  returns) and `apps/functions/src/api/notion/text-reminder.ts:78-84`.

## Module layout

Conventional 5-section file shape, verified in
`apps/functions/src/api/notion/text-reminder.ts`:

1. **External imports**, alphabetised within each package (`:1-10`).
2. **Internal imports** `./relative` → `../up` (`:11-12`).
3. **Module-scope clients + SCREAMING_SNAKE constants** (`:15-20`).
4. **Internal helpers** (`:22-73`).
5. **Exported handlers / public API** (`:75-end`).

Same shape in `apps/functions/src/api/notion/webhook.ts`
(externals at `:1-4`, internals at `:5-6`, ssmClient + type at `:8-23`,
exported handler at `:25-end`).

## Error handling

- **HTTP handlers return `new Response('Reason', { status: NNN })`** —
  direct, no framework helper. See
  `apps/functions/src/api/notion/webhook.ts:28, 31, 37, 91, 114, 117`.
  Status codes match real semantics: 405 wrong method, 400 malformed,
  401 unauthorized, 500 on rejection.
- **Webhook returns 500 to force Notion retry** when any handler in
  `Promise.allSettled` rejected
  (`apps/functions/src/api/notion/webhook.ts:108-114`). Don't `catch` to
  swallow — Notion's retry is the recovery loop, and handlers are
  idempotent by design.
- **AWS SDK exceptions matched via `instanceof`** for SDK-exported types
  (`ConflictException` at
  `apps/functions/src/api/notion/text-reminder.ts:52`). Fall back to
  `instanceof Error && e.name === '...'` for non-exported types
  (`ResourceNotFoundException` at
  `apps/functions/src/api/notion/text-reminder.ts:173`). Never
  string-match the message.
- **Logging is plain `console.log` / `console.error`** with a string
  label and a structured object — no structured logger
  (`apps/functions/src/api/notion/webhook.ts:106-110`,
  `apps/functions/src/api/notion/text-reminder.ts:50, 68, 175`). PII
  masking: phone numbers always `***${phone.slice(-4)}` (see
  `universal.md`).

## Repetition vs reuse

- **"Almost-but-not-quite" duplicates stay separate.**
  `CreateScheduleCommand` and `UpdateScheduleCommand`
  (`apps/functions/src/api/notion/text-reminder.ts:35-50` and `:53-69`)
  repeat 6 fields each rather than extracting common args — the
  parameter lists differ in only one field and merging would force a
  half-fitting common shape.
- **Inline `for…of` over array helpers** when the loop has side effects
  spanning multiple AWS calls
  (`apps/functions/src/api/notion/text-reminder.ts:88-89, 117-118, 145-148,
  151-153, 157-158`). The code keeps the explicit imperative form
  rather than chained `.map`/`.forEach`.

## Lambda-handler specifics

- Resources accessed via `Resource.<Name>.value` (typed via
  `sst-env.d.ts`). Only use `process.env` for non-SST fields explicitly
  set in infra (`SCHEDULER_GROUP_NAME`, `SCHEDULER_INVOKE_ROLE_ARN`,
  `TEXT_FUNCTION_ARN`, `DOMAIN`, `GITHUB_NOTION_SYNC_URL` —
  see `infra/api.ts:85-90`).
- `Promise.allSettled` + rejected-filter for fan-outs
  (`apps/functions/src/api/notion/webhook.ts:95-110`).
- Re-export shared types from one handler file and import via relative
  path: `NotionWebhookEvent` exported at `webhook.ts:10-23`, imported
  by both sibling handlers (`text-reminder.ts:12`, `gh-blog-sync.ts:2`).

### Handler file placement

- **HTTP/webhook fan-out handlers** go under
  `apps/functions/src/api/<surface>/<handler>.ts` — e.g.,
  `apps/functions/src/api/notion/{webhook,text-reminder,gh-blog-sync}.ts`.
  The top-level `api/` segment is the convention for anything fronted
  by `apiRouter` (`infra/api.ts:13`).
- **Standalone single-purpose handlers** (one Lambda, one file) go at
  the top of `apps/functions/src/<noun>.ts` — e.g.,
  `apps/functions/src/text.ts` holds `sendTextHandler`. Use this when
  the function isn't part of a multi-handler surface.
- **Multi-file features** (handler + types + helpers) go under
  `apps/functions/src/<feature>/{handler,types,helpers}.ts`. The
  apartment-search sandbox used this layout when it existed
  (now removed — see `gotchas/functions.md` Sandbox placeholder).
- **Shared utilities** go under `apps/functions/src/lib/<noun>.ts` —
  see `apps/functions/src/lib/pii.ts`.

### Lambda → Lambda invocation

No live in-repo example yet. When you need it:

- Use `@aws-sdk/client-lambda` `InvokeCommand` with
  `InvocationType: 'Event'` for fire-and-forget (no response needed,
  AWS retries on transient failure with its own at-least-once
  semantics) or `InvocationType: 'RequestResponse'` for synchronous.
- Grant `lambda:InvokeFunction` on the target function's ARN in the
  caller's `permissions` block (`infra/api.ts:73-89` shows the
  permissions array shape — add a new entry).
- Pass the target ARN via `environment.<NAME>_FUNCTION_ARN` (same
  pattern as `TEXT_FUNCTION_ARN` at `infra/api.ts:89`); ARNs aren't
  `sst.Linkable` so they don't fit `link:`.
- Match the payload shape to the target handler's expected event
  type. `sendTextHandler` accepts `{ phoneNumber: string; message:
  string }` directly (`apps/functions/src/text.ts:6`).

## Comments

- Default zero. Real WHY-only annotations:
  - `apps/functions/src/api/notion/webhook.ts:92-94` —
    `// WARNING: Handlers MUST be idempotent — Notion retries the webhook on non-200 responses`
  - `apps/functions/src/api/notion/gh-blog-sync.ts:4` —
    `// NOTE: notion UUIDs are inconsistent with the same resource. sometimes dashes and sometimes not`
  - `apps/functions/src/api/notion/webhook.ts:40` —
    `/** INITIALIZE WEBHOOK WITH NOTION */` section header for the
    multi-branch handler.
- Multi-line block-quote style is fine for verification-token operator
  instructions (`apps/functions/src/api/notion/webhook.ts:53-71`) — a
  rare case where the comment is for a human reader running a one-time
  bootstrap.
