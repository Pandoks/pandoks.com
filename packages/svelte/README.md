# Svelte library

This is a component library that is shared across this monorepo. `package.json` exports
`./shadcn/*`, `./styles/*`, and `./svg/*` as wildcards, so new files under those paths are exported
automatically. When you add a new top-level category, remember to add it to the exports in
`package.json` in this package.

> [!IMPORTANT]
> Instead of using `$lib`, use `@lib` instead. This is so that you can reference this package in
> `svelte.config.js` in other packages. If you were to use `$lib`, other packages would look into
> their own `$lib` instead of this package which may not contain the necessary code.

This component library houses all the `shadcn-svelte` components (add more with
`pnpm shadcn <component>` from the repo root), shared styles, and SVGs.

For static files, put them in the `static` directory. Apps copy `static/fonts` into their builds via
`vite-plugin-static-copy`, so add anything else they need to their `vite.config.ts`.

## Development

The `routes` is meant for you to test out components in isolation so that you can see how they look.
They are not meant to be exported and used in other packages.
