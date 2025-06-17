import { NOTION_API_KEY } from '$env/static/private';
import { Client } from '@notionhq/client';

const notion = new Client({
  auth: NOTION_API_KEY
});

export const getBlogPosts = async (databaseId: string) => {
  try {
    const databaseResponse = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'Publish',
        checkbox: {
          equals: true
        }
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }]
    });
    const pages = databaseResponse.results;

    let posts = [];
    for (const page of pages) {
      const blockResponse = await notion.blocks.children.list({
        block_id: page.id
      });
      const blocks = blockResponse.results;
      blocks.filter((block) => !block.archived && !block.in_trash);

      posts.push({ page, blocks });
    }

    console.log(posts);
    return posts;
  } catch (e) {
    console.error('Error fetching Notion data:', e);
  }
};
