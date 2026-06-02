---
paths:
  - 'apps/web/**'
  - 'packages/svelte/**'
---

# Gotchas — apps/web + @pandoks.com/svelte

## Build pipeline

- **`blog/[title]/` is hidden during build when no posts exist.** A Vite
  plugin (`apps/web/vite/plugins/hide-blog.ts`) moves the route to
  `.temp/blog/` in `buildStart` if `hasPosts` is false, and restores it
  in `closeBundle`. Registered first in the plugin pipeline at
  `apps/web/vite.config.ts:13` (`hideBlogWhenEmpty()` before
  `sveltekit()`). **If a build dies mid-way, the folder may be in
  `.temp/`** — rerun the build; the plugin's `buildStart` recovers it
  (`hide-blog.ts:28-31`).
- **`__HAS_POSTS__`** is a Vite `define` global (set in
  `apps/web/vite/globals.ts`) consumed by `+layout.svelte:25` to decide
  whether to render the Blog nav link. So the nav link, the route, and
  the layout-level prefetch all hide together.
- **Notion content is fetched by a standalone script**, not inside the
  Vite build. `apps/web/scripts/notion.ts` syncs the Notion DB to
  **`apps/web/src/lib/blog/*.json`** (+ `src/lib/blog/images/`,
  `notion.ts:107-108, 271`) at the timing of the `sync-notion.yaml`
  workflow (manual / Notion-webhook-triggered). The route dir
  `routes/blog/[title]/` holds only `+page.svelte` + `+page.ts`, which
  read that synced JSON via `import.meta.glob('/src/lib/blog/*.json')`.
- **Build crashes on missing Notion data are intentional.** Better to
  fail the build than ship empty pages.

## Notion API

- **Pinned to `2026-03-11`** in two places:
  `apps/web/scripts/notion.ts:131` and
  `apps/functions/src/api/notion/text-reminder.ts:15`. Don't bump
  without testing every block transform in `apps/web/scripts/notion.ts`.
- **Uses `dataSources.query()`** (modern API), not the classic database
  query. The data source ID is resolved on each sync run inside
  `apps/web/scripts/notion.ts`.

## Route choice

- **Use `+page.ts`, never `+page.server.ts`** — there are **zero**
  `+page.server.ts` files in `apps/web/src`. The blog is NOT an
  exception: `blog/[title]/+page.ts` (`prerender = true`) reads the
  **pre-synced** `src/lib/blog/*.json` at build via `import.meta.glob`
  — the Notion API is hit only by the out-of-band `notion.ts` script,
  never at request/build time of the route itself.
- `apps/web/src/routes/+layout.ts` sets `export const prerender = true`;
  `blog/[title]/+page.ts` also sets it (the blog content load).

## Static assets

- **Static fonts come from the workspace package**, copied via
  `vite-plugin-static-copy` in `apps/web/vite.config.ts:16-22` from
  `../../packages/svelte/static/fonts/*`. **Don't add fonts to
  `apps/web/static/`.** The font registry consumed at runtime is
  `apps/web/src/lib/fonts.ts` (referenced from `+layout.svelte:8, 15`).
- **Blog images go to `apps/web/src/lib/blog/images/`** (written by
  `notion.ts:108`, served via the `import.meta.glob` enhanced-img
  pipeline in `+page.ts`), NOT `static/`. The `static/blog-images/`
  `.gitignore` entry (`.gitignore:63`) is for a path `notion.ts` no
  longer uses — don't rely on it.

## Workspace imports

- **Components import via `@pandoks.com/svelte/shadcn/<component>`** (the
  workspace exports map, `packages/svelte/package.json:21-26`). Never
  reach into `packages/svelte/src/...` from app code.
- **Raw SVGs**: `@pandoks.com/svelte/svg/x.svg?raw` → `{@html svg}`.
- **`pnpm shadcn <component>`** at repo root (`package.json:18`) —
  never run `shadcn-svelte` directly in an app.
- **Apps alias `@lib` → `../../packages/svelte/src/lib`** in
  `apps/web/svelte.config.js:15-18`.
