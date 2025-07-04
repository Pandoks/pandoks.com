import { dev } from '$app/environment';
import { NOTION_API_KEY, BLOG_NOTION_DATABASE_ID } from '$env/static/private';
import { Client } from '@notionhq/client';
import { getImageExtensionFromSignedUrlImage } from './utils';

export const notion = new Client({
  auth: NOTION_API_KEY
});

export const minimizeNotionBlockData = async (block: any) => {
  switch (block.type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'paragraph':
      return {
        type: block[block.type].rich_text[0].href ? 'link' : block.type,
        text: block[block.type].rich_text[0].plain_text
      };
    case 'image':
      const imageUrl = block[block.type].file.url;
      if (dev) {
        return { type: block.type, url: imageUrl };
      }
      const extension = await getImageExtensionFromSignedUrlImage(imageUrl);
      return {
        type: block.type,
        url: `${block.id}${extension}`
      };
    default:
      throw new Error(`Unsupported block type: ${block.type}`);
  }
};

export const getAllBlogTitles = async () => {
  let titles = [];
  let cursor;

  do {
    const pageResponse = await notion.databases.query({
      database_id: BLOG_NOTION_DATABASE_ID,
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
