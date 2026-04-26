import { join, resolve } from 'path';

export const WEB_DIR = process.cwd();
export const BUILD_DIR = join(WEB_DIR, 'build');
export const TEMP_DIR = join(WEB_DIR, '.temp');
export const HIDDEN_BLOG = join(TEMP_DIR, 'blog');
export const BLOG_ROUTE = join(WEB_DIR, 'src/routes/blog');
export const BLOG_CONTENT_DIR = join(WEB_DIR, 'src/lib/blog');
export const FONTS_DIR = resolve(WEB_DIR, '../../packages/svelte/static/fonts');
