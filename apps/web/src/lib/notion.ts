import { NOTION_API_KEY } from '$env/static/private';
import { Client } from '@notionhq/client';

export const notion = new Client({
  auth: NOTION_API_KEY
});

export const getPageAndBlocksData = async ({
  databaseId,
  filter
}: {
  databaseId: string;
  filter: any;
}) => {
  const pagesResponse = await notion.databases.query({
    database_id: databaseId,
    filter,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }]
  });
  const pages = pagesResponse.results;

  const posts = [];
  for (const page of pages) {
    const blockResponse = await notion.blocks.children.list({
      block_id: page.id
    });
    const blocks = blockResponse.results.filter(
      (block) => !block.archived && !block.in_trash && block.type !== 'bookmark'
    );
    posts.push({ page, blocks });
  }

  return posts;
};
