---
paths:
  - '**/*.svelte'
  - '**/*.svelte.ts'
  - 'apps/web/**/*.ts'
  - 'packages/svelte/**/*.ts'
---

# Code style — Svelte 5

Svelte 5 runes are mandatory. No Svelte 4 store/slot patterns in new code.

## Runes

- `$props()`, `$state()`, `$bindable()`, `$derived`, `$effect`.
  Real: `const { children }: { children: Snippet } = $props()`
  (`apps/web/src/routes/+layout.svelte:11`),
  `let activeNavIndex: number | undefined = $state()`
  (`apps/web/src/routes/+layout.svelte:28`).
- **Destructure `$props()`** with defaults + `...restProps` spread for
  component pass-through.
- **Explicit `Snippet` annotation for `children`** instead of letting it
  infer to `unknown` (`+layout.svelte:9, 11`).
- **`bind:this={ref}`** pairs with `ref = $bindable(null)` _inside_ a
  component's own implementation. Consumers of shadcn components use
  **`bind:ref={ref}`** — the components re-expose their internal `ref`
  prop as `$bindable(null)`
  (`packages/svelte/src/lib/components/ui/input/input.svelte:13`,
  `packages/svelte/src/lib/components/ui/button/button.svelte:46`). So:
  - In **your own component file**: `let { ref = $bindable(null) } = $props();` + `<input bind:this={ref} ...>`.
  - In **consumer code**: `let ref: HTMLInputElement | null = $state(null);` + `<Input bind:ref={ref} ... />`.
- **`.svelte.ts`** for runed state living outside components
  (`apps/web/src/lib/vim.svelte.ts`). Regular `.ts` for plain libraries
  (`apps/web/src/lib/fonts.ts`, `apps/web/src/lib/highlight.ts`).

## Snippets, not slots

- **Snippets over slots**: `{#snippet name(...)}` + `{@render name(...)}`
  for repeated markup. `apps/web/src/routes/+layout.svelte:80` defines
  a `navLink` snippet and renders it from inside the `{#each}` at
  `apps/web/src/routes/+layout.svelte:69-71`.

## HTML escape hatches

- **`{@html ...}` reserved for raw SVG** imported with `?raw`. No other
  legitimate use.
- **Raw SVGs imported from the workspace package**:
  `@pandoks.com/svelte/svg/<name>.svg?raw` → `{@html svg}`. Never inline
  SVG markup.

## Class composition

- **Template literals + ternaries in app code**
  (`apps/web/src/routes/+layout.svelte:87`).
- **`cn()` from `@lib/utils` only inside shared shadcn components**
  (`packages/svelte/src/lib/components/ui/button/button.svelte:2`) —
  never in app-level code.

## Variants

- **`tailwind-variants`** (`tv({ base, variants, defaultVariants })`).
  See `packages/svelte/src/lib/components/ui/button/button.svelte:6-30`.
  Export both the variant function and its `VariantProps` type from the
  component's `index.ts`.

## Script blocks

- **Module-level `<script lang="ts" module>`** for exported types/variants.
- **Per-instance state in the regular `<script lang="ts">`** block.

## Context API

- **Typed-key pattern**: `getContext<T>(key)` / `setContext(key, x)` with a
  module-scope `DEFAULT_KEY` constant
  (`apps/web/src/lib/vim.svelte.ts:146`).

## Vim-mode navigation (`vim.svelte.ts`)

The site-wide keypress UX is owned by `apps/web/src/lib/vim.svelte.ts`.
`+layout.svelte:29-35` calls `setVimState()` once at the layout level;
every page reads it with `getVimState()`.

- **Nav handler** lives at the layout (`+layout.svelte:36-64`). Pages
  should not register a nav handler.
- **Body handler** is per-page. Use the fluent setters:
  `getVimState().setBodyHandler((e) => { ... })
 .setInitBodyState(() => { ... })
 .setResetBodyState(() => { ... })`.
  Canonical example: `apps/web/src/routes/socials/+page.svelte`.
- **Reserved keys** owned by the master listener (`vim.svelte.ts:69-105`)
  — DO NOT consume in your handler:
  - `y` — copies `window.location.href`.
  - `Escape` — sets `active = 'none'`.
  - `j` / `k` — used to switch _between_ nav and body modes.
- **`bodyTop` / `bodyBottom` are the load-bearing contract** for letting
  your page's `j`/`k` work as in-body movement instead of triggering
  mode-switch.
  - When `bodyBottom = true` (default), pressing `j` while in `body`
    switches to `nav` mode (`vim.svelte.ts:78-82`).
  - When `bodyTop = true` (default), pressing `k` while in `body`
    switches to `nav` mode (`vim.svelte.ts:89-94`).
  - To use `j`/`k` for in-page cursor movement, your body handler must
    mutate `vimState.bodyTop = false` / `bodyBottom = false` as soon as
    the cursor leaves the edges, and restore them when it returns. The
    master listener checks these flags _before_ dispatching to your
    handler (`vim.svelte.ts:80, 92` — `if (!this.bodyBottom) return;`
    is the load-bearing line that lets the body handler get the event).
  - **Canonical invariant after any cursor move:**
    `bodyTop = (activeIndex === 0)` and `bodyBottom = (activeIndex === lastIndex)`.
    Apply this in both the body handler (on each `j`/`k`) AND in
    `setInitBodyState` (when entering body mode from nav). The
    `socials/+page.svelte` page uses `h`/`l` for horizontal movement
    instead of `j`/`k`, so it doesn't exercise this invariant — for
    vertical-list pages you own the flag-mutation logic.

### Vim + focusable inputs (forms)

**The vim system is currently incompatible with pages containing
focusable inputs** (`<input>`, `<textarea>`, `contenteditable`). The
master listener at `apps/web/src/lib/vim.svelte.ts:37` is bound to
`keypress` on `document`. `keypress` fires _after_ the character has
been committed to the focused element, so navigation keys like
`j`/`k`/`h`/`l` would both type the literal character into the input
AND fire the body handler — visible double-effect. There is no
existing in-repo precedent for solving this.

If you need a vim-navigable form, options (none of which the codebase
has chosen yet — discuss with the user before picking one):

1. Don't focus the input until the user presses Enter on a row;
   navigate row-level wrappers instead. Vim keys move between rows;
   focusing the underlying input takes the user out of vim mode (e.g.,
   set `vimState.active = 'none'` on focus).
2. Switch the master listener to `keydown` and `preventDefault()` on
   navigation keys when `active === 'body'`. Requires editing
   `vim.svelte.ts` and re-validating every existing page.
3. Use a non-letter key set for the form page only (arrow keys,
   tab-like), bypassing the issue.

Flag this explicitly to the user when the task involves a form.

### CORS for browser-facing handlers

**No browser-facing Lambda exists yet** (`NotionWebhookHandler` is
server-to-server from Notion). When adding one, the handler must:

- Respond to `OPTIONS` preflight with the appropriate
  `Access-Control-Allow-*` headers BEFORE the method check.
- Return `Access-Control-Allow-Origin` on every real response. Pin to
  `https://pandoks.com` rather than `*`.
- Use `Response` with a `Headers` instance, e.g.
  `new Response(body, { status, headers: { 'Access-Control-Allow-Origin': 'https://pandoks.com' } })`.

This is uncharted territory in this repo — when you ship the first
browser-facing endpoint, document the chosen CORS shape here so future
handlers copy it instead of reinventing.

- **`vimState.active`** is `$state`-tracked (`vim.svelte.ts:32`) — read
  it in class bindings to highlight the active row (e.g.,
  `${activeIndex === i && vimState.active === 'body' ? 'bg-highlight' :
''}`, mirroring `+layout.svelte:87`).

## Installed shadcn components

The workspace exports map (`packages/svelte/package.json:21-26`) lets
you import `@pandoks.com/svelte/shadcn/<component>` for any directory
under `packages/svelte/src/lib/components/ui/`. **Currently installed**:

- `badge`, `button`, `input`, `separator`, `sheet`, `sidebar`,
  `skeleton`, `tooltip`.

**Import shape — named exports, PascalCase by component name.** Every
`index.ts` follows shadcn-svelte's standard re-export convention.
Real examples:

- `packages/svelte/src/lib/components/ui/badge/index.ts:1` —
  `export { default as Badge } from './badge.svelte';`
- `packages/svelte/src/lib/components/ui/button/index.ts:8-17` —
  exports both `Root` and `Button` aliases.
- `packages/svelte/src/lib/components/ui/input/index.ts:3-6` —
  `Root` + `Input`.

So `import { Badge } from '@pandoks.com/svelte/shadcn/badge'` and
`import { Button } from '@pandoks.com/svelte/shadcn/button'` are both
correct. Compound components like `sidebar` export multiple named
parts (`Content`, `Footer`, `Group`, `MenuButton`, …) — destructure
what you need.

**Adding a new component:** run `pnpm shadcn <name>` at the repo root
(`package.json:18` — never `shadcn-svelte` directly inside an app).
Confirm with the user before adding new components — installing
`card` / `dialog` / etc. is a workspace change, not a per-page
decision. The list above will drift; `ls
packages/svelte/src/lib/components/ui/` is authoritative.

## Per-page head

- **`<svelte:head>`** for per-page `<title>` / `<meta>`.

## Workspace imports

- **Shadcn components**: `@pandoks.com/svelte/shadcn/<component>` — the
  workspace exports map at `packages/svelte/package.json:21-26`. Never
  reach into `packages/svelte/src/...` directly from app code (workspace
  internals like `@lib/utils.js` are fine inside `packages/svelte` —
  see `button.svelte:2`).
- **App alias**: `@lib` → `../../packages/svelte/src/lib`
  (`apps/web/svelte.config.js:15-18`).
- **`pnpm shadcn <component>`** at repo root (`package.json:18`) —
  never run `shadcn-svelte` directly inside an app.
