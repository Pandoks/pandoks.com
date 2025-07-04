import { dev } from '$app/environment';
import { NOTION_DATABASE_ID } from '$env/static/private';
import { minimizeNotionBlockData, notion } from '$lib/notion';
import type { PageServerLoad } from './$types';

const staticBlogImages = import.meta.glob(
  '/static/blog-images/*.{avif,gif,heif,jpeg,jpg,png,tiff,webp,svg}',
  { eager: true, query: { enhanced: true } }
);

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

export const load: PageServerLoad = async ({ params }) => {
  const page = await getPageByTitle(params.title.replaceAll('-', ' '));

  return {
    title: params.title.replaceAll('-', ' '),
    createdTime: `${MONTHS[page.createdTime.getMonth() - 0]} ${page.createdTime.getFullYear()}`,
    blocks: await getPageBlocks(page.pageId)
  };
};

const getPageBlocks = async (pageId: string) => {
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
        const processedBlock = minimizeNotionBlockData(block).then((block) => {
          if (!dev && block.type === 'image') {
            block.url = staticBlogImages[`/static/blog-images/${block.url}`].default;
          }
          return block;
        });
        processingBlocks.push(processedBlock);
      }
    }

    cursor = blockResponse.next_cursor;
  } while (cursor);

  const blocks = await Promise.all(processingBlocks);
  return blocks;
};

const getPageByTitle = async (title: string) => {
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
      if (page.properties.Title.title[0].plain_text === title) {
        return { pageId: page.id, createdTime: new Date(page.created_time) };
      }
    }

    // will be null if there are no more pages
    cursor = pageResponse.next_cursor;
  } while (cursor);

  // NOTE: we want to crash because this is during build time
  throw new Error(`Could not find page with title ${title}`);
};
