import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { BLOG_ROUTE, BLOG_CONTENT_DIR, HIDDEN_BLOG, TEMP_DIR } from './paths';

// Recover from a previous build that crashed between prebuild and postbuild.
if (existsSync(HIDDEN_BLOG) && !existsSync(BLOG_ROUTE)) {
  renameSync(HIDDEN_BLOG, BLOG_ROUTE);
  console.log('prebuild: recovered blog route from previous crash');
}
if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true });

const hasPosts =
  existsSync(BLOG_CONTENT_DIR) && readdirSync(BLOG_CONTENT_DIR).some((f) => f.endsWith('.json'));

if (!hasPosts && existsSync(BLOG_ROUTE)) {
  mkdirSync(TEMP_DIR, { recursive: true });
  renameSync(BLOG_ROUTE, HIDDEN_BLOG);
  console.log('prebuild: no posts, hid blog route');
}
