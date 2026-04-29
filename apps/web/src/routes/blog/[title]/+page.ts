import type { EntryGenerator, PageLoad } from './$types';
export const entries: EntryGenerator = () =>
  __BLOG_INDEX__.map((post) => ({ title: post.slug }));
