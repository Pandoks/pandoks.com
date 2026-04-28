import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BLOG_DIR = 'src/lib/blog';

const blogIndex = existsSync(BLOG_DIR)
  ? readdirSync(BLOG_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const data = JSON.parse(readFileSync(join(BLOG_DIR, f), 'utf-8')) as {
          title: string;
          createdTime: string;
        };
        return {
          slug: f.replace(/\.json$/, ''),
          title: data.title,
          createdTime: data.createdTime
        };
      })
      .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
  : [];

export const hasPosts = blogIndex.length > 0;

export const define = {
  __HAS_POSTS__: JSON.stringify(hasPosts),
  __BLOG_INDEX__: JSON.stringify(blogIndex)
};
