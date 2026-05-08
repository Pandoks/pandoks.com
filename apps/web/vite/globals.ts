import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BLOG_DIR = 'src/lib/blog';

const blogTitles = existsSync(BLOG_DIR)
  ? readdirSync(BLOG_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const data = JSON.parse(readFileSync(join(BLOG_DIR, f), 'utf-8')) as {
          title: string;
          createdTime: string;
        };
        return { title: data.title, createdTime: data.createdTime };
      })
      .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
      .map((post) => post.title)
  : [];

export const hasPosts = blogTitles.length > 0;

export const hasHomePageBlogPost = blogTitles.includes('The Human Experience');

export const define = {
  __HAS_POSTS__: hasPosts,
  __BLOG_TITLES__: blogTitles,
  __HAS_HOME_PAGE_BLOG_POST__: hasHomePageBlogPost
};
