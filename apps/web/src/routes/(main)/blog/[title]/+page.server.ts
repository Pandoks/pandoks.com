import { NOTION_DATABASE_ID } from '$env/static/private';
import { minimizeNotionBlockData, notion } from '$lib/notion';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const blocks = getPageBlocks(params.title.replaceAll('-', ' '));

  return {
    blocks: await blocks
  };
};

const getPageBlocks = async (title: string) => {
  const pages = await getAllPages();

  let pageId;
  for (const page of pages) {
    if (page.title === title) {
      pageId = page.id;
      break;
    }
  }
  if (!pageId) {
    // NOTE: we want to crash because this is during build time
    throw new Error(`Could not find page with title ${title}`);
  }

  let processingBlocks = [];
  let cursor;
  do {
    const blockResponse = await notion.blocks.children.list({
      block_id: pageId!,
      start_cursor: cursor,
      page_size: 100
    });

    for (const block of blockResponse.results) {
      if (!block.archived && !block.in_trash && block.type !== 'bookmark') {
        processingBlocks.push(minimizeNotionBlockData(block));
      }
    }

    cursor = blockResponse.next_cursor;
  } while (cursor);

  const blocks = await Promise.all(processingBlocks);
  return blocks;
};

const getAllPages = async () => {
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
      pages.push({ id: page.id, title: page.properties.Title.title[0].plain_text as string });
    }

    // will be null if there are no more pages
    cursor = pageResponse.next_cursor;
  } while (cursor);

  return pages;
};
