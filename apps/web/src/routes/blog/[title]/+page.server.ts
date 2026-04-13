import { dev } from '$app/environment';
import { blogDataSourceIdPromise, minimizeNotionBlockData, notion } from '$lib/notion';
import { isFullBlock, isFullPage } from '@notionhq/client';
import type { PageServerLoad } from '../[title]/$types';

const staticBlogImages = import.meta.glob<{ default: string }>(
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
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100
    });

    for (const block of blockResponse.results) {
      if (!isFullBlock(block) || block.in_trash || block.type === 'bookmark') continue;

      const processedBlock = minimizeNotionBlockData(block).then((block) => {
        if (!dev && block.type === 'image') {
          block.url = staticBlogImages[`/static/blog-images/${block.url}`].default;
        }
        return block;
      });
      processingBlocks.push(processedBlock);
    }

    cursor = blockResponse.next_cursor;
  } while (cursor);

  return Promise.all(processingBlocks);
};

const getPageByTitle = async (title: string) => {
  let cursor;
  const dataSourceId = await blogDataSourceIdPromise;
  do {
    const pageResponse = await notion.dataSources.query({
      data_source_id: dataSourceId,
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
      if (!isFullPage(page)) continue;

      const titleProperty = page.properties['Title'];
      if (titleProperty?.type !== 'title') continue;

      if (titleProperty.title[0]?.plain_text === title) {
        return { pageId: page.id, createdTime: new Date(page.created_time) };
      }
    }

    cursor = pageResponse.next_cursor ?? undefined;
  } while (cursor);

  // NOTE: we want to crash because this is during build time
  throw new Error(`Could not find page with title ${title}`);
};
