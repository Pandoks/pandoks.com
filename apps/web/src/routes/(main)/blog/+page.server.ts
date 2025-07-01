import { NOTION_DATABASE_ID } from '$env/static/private';
import { notion } from '$lib/notion';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const titles = getAllBlogTitles();
  return {
    titles: await titles
  };
};

// NOTE: no need to try catch because it should throw an error during build time if it can't get the data
const getAllBlogTitles = async () => {
  let titles = [];
  let cursor;

  do {
    const pageResponse = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      filter: {
        property: 'Publish',
        checkbox: {
          equals: true
        }
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      start_cursor: cursor
    });

    for (const page of pageResponse.results) {
      titles.push(page.properties.Title.title[0].plain_text as string);
    }

    // will be null if there are no more pages
    cursor = pageResponse.next_cursor;
  } while (cursor);

  return titles;
};
