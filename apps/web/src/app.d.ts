// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

// Source of truth for the values injected by Vite's `define` (see vite.config.ts).
// `import type` is erased at compile time, so this does NOT pull node:fs into the client bundle.
import type { hasPosts, blogIndex } from '../vite/declarations';

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  const __HAS_POSTS__: typeof hasPosts;
  const __BLOG_INDEX__: typeof blogIndex;
}

export {};
