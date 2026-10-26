# Svelte library

This is a component library that is shared across this monorepo. `package.json` exports
`./shadcn/*`, `./styles/*`, and `./svg/*` as wildcards, so new files under those paths are exported
automatically. When you add a new top-level category, remember to add it to the exports in
`package.json` in this package.

> [!IMPORTANT]
> Apps import this package by name (`@pandoks.com/svelte/...`) through its `exports`. Inside this
> package, import with `#lib/...` and explicit file extensions (the `imports` map in
> `package.json`), which `components.json` makes `shadcn-svelte` generate.

This component library houses all the `shadcn-svelte` components (add more with
`pnpm shadcn <component>` from the repo root), shared styles, and SVGs.

For static files, put them in the `static` directory. Apps copy `static/fonts` into their builds via
`vite-plugin-static-copy`, so add anything else they need to their `vite.config.ts`.

## Development

The `routes` is meant for you to test out components in isolation so that you can see how they look.
They are not meant to be exported and used in other packages.
