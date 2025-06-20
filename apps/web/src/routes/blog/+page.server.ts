import { NOTION_DATABASE_ID } from '$env/static/private';
import { notion } from '$lib/notion';

export const load = async () => {
  const posts = getBlogPosts(NOTION_DATABASE_ID);

  return {
    posts: await posts
  };
};

// NOTE: no need to try catch because it should throw an error during build time if it can't get the data
const getBlogPosts = async (databaseId: string) => {
  const pagesResponse = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: 'Publish',
      checkbox: {
        equals: true
      }
    },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }]
  });
  const pages = pagesResponse.results;

  let posts = [];
  for (const page of pages) {
    const blockResponse = await notion.blocks.children.list({
      block_id: page.id
    });
    const blocks = blockResponse.results
      .filter(
        (block) =>
          !block.archived &&
          !block.in_trash &&
          (block.type === 'paragraph' || block.type === 'image')
      )
      .map((block) =>
        block.type === 'paragraph'
          ? { type: block.type, text: block.paragraph.rich_text[0].plain_text }
          : { type: block.type, url: block.image.file.url }
      );

    const post = {
      title: page.properties.Title.title[0].plain_text,
      summary: page.properties.Summary.rich_text[0].plain_text,
      createdTime: page.created_time,
      lastEditedTime: page.last_edited_time,
      blocks
    };
    console.log(post);
    posts.push(post);
  }

  return posts;
};
