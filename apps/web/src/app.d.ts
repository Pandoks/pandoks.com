// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

// Source of truth for the values injected by Vite's `define` (see vite.config.ts).
// `import type` is erased at compile time, so this does NOT pull node:fs into the client bundle.
import type { define } from '../vite/globals';

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  const __HAS_POSTS__: typeof define.__HAS_POSTS__;
  const __BLOG_TITLES__: typeof define.__BLOG_TITLES__;
  const __HAS_HOME_PAGE_BLOG_POST__: typeof define.__HAS_HOME_PAGE_BLOG_POST__;
}

export {};
