---
paths:
  - 'apps/functions/**'
---

# Gotchas — apps/functions

## Notion webhook idempotency

- **Handlers MUST be idempotent.** Explicit reminder at
  `apps/functions/src/api/notion/webhook.ts:92-94`. Notion retries on
  non-200; if any handler in `Promise.allSettled` rejects, the whole
  webhook returns 500 and every succeeded handler re-runs.
- **Idempotency anchor**: deterministic schedule names —
  `schedule-notion-text-${pageId}-${sha256(phone).slice(...)}`
  (`apps/functions/src/api/notion/text-reminder.ts:22-26`).
  `CreateScheduleCommand` with `ConflictException` →
  `UpdateScheduleCommand` (`:35-72`).
- **Notion bootstrap token lands in SSM.** First webhook call posts a
  `verification_token`; handler stores it at
  `/tmp/notion-verification-token`
  (`apps/functions/src/api/notion/webhook.ts:41-72`) and logs the AWS
  console URL plus the exact `sst secret set` command. Operator runs the
  command and redeploys. **Delete the SSM parameter afterwards** — the
  log reminder lives at `webhook.ts:69`.

## EventBridge Scheduler IAM

- **The webhook handler has `iam:PassRole` on `ScheduleInvokeTextRole`**
  (`infra/api.ts:80-83`) — required for EventBridge Scheduler
  `Target.RoleArn`. Don't drop the policy if you refactor.
- `SCHEDULER_INVOKE_ROLE_ARN` is passed via `environment` (not SST
  `link`) at `infra/api.ts:86-90` because role ARNs aren't `sst.Linkable`.

## Twilio

- **`text.ts` passes both `from` and `messagingServiceSid`**
  (`apps/functions/src/text.ts:9-11`). The messaging service SID is the
  operative sender (pooled senders, not a single phone); `from` is along
  for the ride but doesn't take precedence when `messagingServiceSid` is
  present. Don't drop the `messagingServiceSid` thinking `from` will
  cover.

## Phone-number map

- **`apps/functions/src/lib/pii.ts`** owns `PHONE_NUMBER_MAPPINGS` (name
  → phone via SST `Resource.<Name>PhoneNumber.value`). When adding a new
  **person** recipient (someone with a Notion identity that can be
  assigned to a page), add the secret in `infra/secrets.ts` under the
  `personal` namespace, link it on the `TextSms` function in
  `infra/api.ts` (so SMS bodies computed inside `text.ts` can read it),
  then extend the mapping here. The `Users` type at `:8` is the typed
  union of all known names.
- **For ad-hoc recipients** (a number that receives one specific kind of
  alert, not tied to a Notion user) — link the secret on
  `NotionWebhookHandler` (or whichever Lambda computes the message),
  read it via `Resource.<Name>.value` there, and pass `{ phoneNumber,
message }` to `TextSms` via the existing invoke shape
  (`text.ts:6` accepts `{ phoneNumber, message }` directly). Don't
  pollute `PHONE_NUMBER_MAPPINGS` with non-user recipients.

## Idempotency patterns for fan-out handlers

Notion retries non-200 webhooks; every handler in
`Promise.allSettled` re-runs on each retry. Two proven patterns:

1. **Deterministic-name + ConflictException** (EventBridge schedules,
   DynamoDB conditional writes, S3 If-None-Match) — see
   `text-reminder.ts:22-26` (deterministic schedule name) +
   `text-reminder.ts:50-72` (Create → catch Conflict → Update). This is
   the preferred pattern when there's a stateful resource you're
   upserting.
2. **No-op on observed state** (the action is naturally idempotent —
   GitHub `workflow_dispatch` queues a fresh run regardless, S3 `PutObject`
   replaces, etc.) — see `gh-blog-sync.ts` which just dispatches the
   workflow each time.

**One-shot side effects with no natural idempotency key** (sending an
SMS, posting to a webhook, charging a card) need an _explicit_ dedup
record — e.g., a small DynamoDB table keyed on `body.id` with a TTL.
This repo doesn't yet have one. If you're adding such a handler, either
(a) introduce the dedup table as part of the same PR and document it
here, or (b) accept duplicate fires at-least-once and call that out in
the PR description. **Do not silently rely on Notion not retrying** —
they do.

## Sandbox dir is empty (placeholder)

- `apps/functions/src/sandbox/.gitkeep` only — the apartment-scraper
  experiment lived here until it was removed. If you add a new sandbox
  Lambda, mirror the prior layout (`<feature>/handler.ts`,
  `<feature>/types.d.ts`) and add the resource in
  `infra/sandbox/<feature>.ts`, gated _inside_ the file with
  `if ($app.stage === 'pandoks')` so the import in `sst.config.ts` can
  stay unconditional.
