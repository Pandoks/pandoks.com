# Universal

Always-loaded. Cross-cutting rules + invariants that apply regardless of which
area is being edited.

## Universal coding rules

- **pnpm only** — never npm/npx. Use `pnpm dlx` for one-off binaries.
  `package.json:17-19` calls `pnpm` directly; the workspace is pinned to
  `pnpm@11.2.2` (`package.json:4`), engines require `pnpm >=11` (`:8`).
- **Minimize comments.** Default to zero. Only write one for non-obvious
  WHY: hidden constraints, invariants, intentional crashes, workarounds
  for specific bugs. Bare comments are fine — most live comments in the
  repo are unprefixed (e.g., `infra/vps/vps.ts:1, 8, 14, 24`,
  `infra/secrets.ts:60`, `apps/functions/src/api/notion/gh-blog-sync.ts:4`).
  Use `NOTE:` / `WARNING:` / `TODO:` prefixes only when the comment is a
  load-bearing safety rail or an operator instruction that a future
  reader needs to spot at a glance — the bar is "would skipping this
  break something subtly?" not "is this a comment?":
  - `infra/tailscale.ts:11-13` —
    `// WARNING: a change to this will overwrite the ACL on all stages`
  - `apps/functions/src/api/notion/webhook.ts:92-94` —
    `// WARNING: Handlers MUST be idempotent`
  - `sst.config.ts:22` —
    `// NOTE: for some reason, dynamic imports don't work well`
  - `package.json:43` (the `// TODO` for pnpm overrides upstream blocker
    — exists in the JSON-with-comments via the leading `//TODO` key).
- **Single-use constants stay in their file.** Don't extract to `$lib` /
  shared module unless ≥2 files use it.
- **Conventional commits.** Active set: `feat()`, `fix()`, `update()`,
  `chore()`, `refactor()`, `cleanup()`, `build()`. PR number in parens at end.
  `update()` is reserved for enhancements to existing features (it co-exists
  with `feat()`, not a replacement).
- **PII masking in logs**: phone numbers always logged as
  `***${phone.slice(-4)}` (`apps/functions/src/api/notion/text-reminder.ts:50, 68`).
  Phone-number map lives at `apps/functions/src/lib/pii.ts` (`PHONE_NUMBER_MAPPINGS`).

## Don't guess external facts — verify or dig

When writing or modifying code in this repo you'll regularly hit
**domain-knowledge gaps** that rules cannot pre-fill:

- Third-party container env-var names (`MB_ENCRYPTION_SECRET_KEY`,
  `SECRET_KEY_BASE`, `LD_SUPERUSER_PASSWORD`).
- Library API shapes (`@aws-sdk/client-lambda`'s `InvokeCommand`
  payload encoding, Notion `multi_select` property type guard).
- Protocol field names (`CLUSTER INFO`'s `cluster_slots_assigned`,
  `INFO replication`'s `master_host`).
- Port numbers, default endpoints, metrics paths for upstream
  containers.
- Whether an image is public or private on ghcr.io.
- Latest stable version of a library / chart / image you're pinning.

**Rule:** before committing such a fact to code or a manifest, invoke
the `verify` skill (for a specific factual claim) or the `dig` skill
(when the answer needs decomposing across multiple sources). Do not
write speculative values from training memory — they go stale and
silently ship wrong env-var names or wrong ports.

Skip verification only when:

- The user explicitly stated the value (e.g., "use port 9090,
  `/metrics`").
- The value is a long-stable built-in (POSIX, basic git, ECMAScript
  core).
- You're inside framed speculation ("if Plausible exposes metrics,
  here's roughly what it would look like…").

When `verify`/`dig` aren't available (subagent context, restricted
tools), explicitly mark unverified values with `# TODO: verify` or
`/* TODO: verify */` so a reviewer catches them — never strip the
marker until verified.

## Cross-cutting error-handling invariants

- **Throw to retry.** Webhook returns 500 — upstream (Notion, EventBridge)
  is the retry loop. Don't wrap to log.
- **`Promise.allSettled`** for fan-outs that should not short-circuit
  (`apps/functions/src/api/notion/webhook.ts:95-98`).
- **No try/catch around AWS SDK calls** unless the failure has a specific
  recovery path. Otherwise let the framework log and retry.
- **Build-time crashes are intentional.** Better to fail the build than ship
  broken pages.
- **Idempotency required** anywhere upstream retries — Notion webhook
  handlers and EventBridge schedule upserts. Real anchor:
  deterministic schedule names + `CreateScheduleCommand` →
  `ConflictException` → `UpdateScheduleCommand`
  (`apps/functions/src/api/notion/text-reminder.ts:22-26, 50-72`).

## Misc invariants

- **`sst-env.d.ts` is auto-generated.** Excluded from prettier in
  `.prettierignore:12` but the project-root copy IS committed for Lambda
  typecheck. Don't edit by hand.
- **`apps/desktop-template` and `apps/example` are excluded from CI.**
  Push trigger exclusions at `.github/workflows/deploy-infra.yaml:10-11`;
  paths-filter exclusion at `:55`
  (`apps/!(desktop-template|example)/**`). Adding either to the deploy
  graph will tank the build.

## Run formatters/linters first

Mechanical surface (indent, quotes, trailing commas, POSIX-sh violations,
unsafe quoting) is enforced by the language-specific dispatchers under
`scripts/lint/`, `scripts/format/`, and `scripts/fix/`. Don't reason about
those rules — run the tools.

| Command                    | What it does                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                | Help (lists subcommands). Run nothing.                                                                            |
| `pnpm lint <lang>`         | One of: `js`, `go`, `helm`, `docker`, `shell`, `actions`, `all`.                                                  |
| `pnpm format <lang>`       | Writes: Prettier / golangci-lint fmt / shfmt -w. Subcommands: `js`, `go`, `shell`, `all`.                         |
| `pnpm format check <lang>` | Same as above but check-only (no writes).                                                                         |
| `pnpm fix <lang>`          | Auto-fixers: `eslint . --fix` (js) / `golangci-lint run --fix` (go).                                              |
| `pnpm check`               | `pnpm -r --if-present check && pnpm check:infra` — workspace svelte-check / tsc + root `tsc -p .` for `infra/**`. |
| `pnpm check:infra`         | `tsc -p .` only — typecheck SST infra (`package.json:23`).                                                        |

Prettier config (`.prettierrc`): `singleQuote: true`,
`trailingComma: 'none'`, `printWidth: 100`, `useTabs: false`, plugins
`prettier-plugin-tailwindcss` + `prettier-plugin-svelte`; Markdown
override at `.prettierrc:9-14` keeps `proseWrap: 'preserve'`.
`.editorconfig` enforces 2-space indent, LF, 100 max line length, and
`shfmt` flags for shell — POSIX variant, `simplify = true`,
`binary_next_line`, `switch_case_indent`, `space_redirects`,
`minify = false`.
