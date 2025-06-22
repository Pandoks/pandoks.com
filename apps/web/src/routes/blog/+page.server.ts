import { NOTION_DATABASE_ID } from '$env/static/private';
import { notion } from '$lib/notion';
import { processSignedUrlImage } from '$lib/utils';

export const load = async () => {
  const posts = getBlogPosts(NOTION_DATABASE_ID);

  return {
    posts: await posts
  };
};

const staticBlogImages = import.meta.glob(
  '/static/blog/*.{avif,gif,heif,jpeg,jpg,png,tiff,webp,svg}',
  {
    eager: true,
    query: {
      enhanced: true
    }
  }
);
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

    const blocks = await Promise.all(
      blockResponse.results
        .filter((block) => !block.archived && !block.in_trash && block.type !== 'bookmark')
        .map(async (block) => {
          const type = block.type;

          if (type === 'image') {
            const baseUrl = await processSignedUrlImage({
              url: block[type].file.url,
              dir: '/blog',
              name: block.id
            });
            const url = staticBlogImages[`/static${baseUrl}`].default;
            return { type, url };
          }

          return { type, text: block[type].rich_text[0].plain_text as string };
        })
    );

    const post = {
      title: page.properties.Title.title[0].plain_text as string,
      summary: page.properties.Summary.rich_text[0].plain_text as string,
      createdTime: new Date(page.created_time),
      lastEditedTime: new Date(page.last_edited_time),
      blocks
    };
    posts.push(post);
  }

  return posts;
};
