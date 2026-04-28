import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { BLOG_DIR, hasPosts } from '../globals';

const ROOT = process.cwd();
const TEMP_DIR = join(ROOT, '.temp');
const HIDDEN_BLOG = join(TEMP_DIR, 'blog');
const BLOG_ROUTE = join(ROOT, BLOG_DIR);

function restore() {
  if (existsSync(HIDDEN_BLOG)) {
    if (existsSync(BLOG_ROUTE)) rmSync(BLOG_ROUTE, { recursive: true, force: true });
    renameSync(HIDDEN_BLOG, BLOG_ROUTE);
  }
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true });
}

export function hideBlogWhenEmpty(): Plugin {
  let hidden = false;

  return {
    name: 'hide-blog-when-empty',
    apply: 'build',
    enforce: 'pre',

    buildStart() {
      if (existsSync(HIDDEN_BLOG) && !existsSync(BLOG_ROUTE)) {
        renameSync(HIDDEN_BLOG, BLOG_ROUTE);
        this.warn('hide-blog-when-empty: recovered route from previous crash');
      }
      if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true });

      if (!hasPosts && existsSync(BLOG_ROUTE)) {
        mkdirSync(TEMP_DIR, { recursive: true });
        renameSync(BLOG_ROUTE, HIDDEN_BLOG);
        hidden = true;
      }
    },

    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (hidden) restore();
      }
    },

    buildEnd(error) {
      if (error && hidden) restore();
    }
  };
}
