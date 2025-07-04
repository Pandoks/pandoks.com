import { getAllBlogTitles } from '$lib/notion';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const titles = getAllBlogTitles();

  return {
    titles: await titles
  };
};
