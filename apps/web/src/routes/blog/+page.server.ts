import { NOTION_DATABASE_ID } from '$env/static/private';
import { notion } from '$lib/notion';

export const load = async () => {
  const posts = getAllBlogPages();
  return {
    posts: await posts
  };
};

// NOTE: no need to try catch because it should throw an error during build time if it can't get the data
const getAllBlogPages = async () => {
  let pages = [];
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
      pages.push({
        id: page.id,
        title: page.properties.Title.title[0].plain_text,
        summary: page.properties.Summary.rich_text[0].plain_text,
        createdTime: new Date(page.created_time),
        lastEditedTime: new Date(page.last_edited_time)
      });
    }

    // will be null if there are no more pages
    cursor = pageResponse.next_cursor;
  } while (cursor);

  return pages;
};
