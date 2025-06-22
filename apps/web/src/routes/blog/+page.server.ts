import { building } from '$app/environment';
import { NOTION_DATABASE_ID } from '$env/static/private';
import { getPageAndBlocksData } from '$lib/notion';

export const load = async () => {
  const posts = getBlogPosts(NOTION_DATABASE_ID);

  return {
    posts: await posts
  };
};

// NOTE: no need to try catch because it should throw an error during build time if it can't get the data
const getBlogPosts = async (databaseId: string) => {
  const pageAndBlocksData = await getPageAndBlocksData({
    databaseId,
    filter: {
      property: 'Publish',
      checkbox: {
        equals: true
      }
    }
  });

  let posts = [];
  for (const { page, blocks } of pageAndBlocksData) {
    const cleanedBlocks = blocks.map((block) => {
      const type = block.type;
      return type === 'image'
        ? { id: block.id, type: type, url: block[type].file.url }
        : { id: block.id, type: type, text: block[type].rich_text[0].plain_text as string };
    });
    posts.push({
      title: page.properties.Title.title[0].plain_text as string,
      summary: page.properties.Summary.rich_text[0].plain_text as string,
      createdTime: new Date(page.created_time),
      lastEditedTime: new Date(page.last_edited_time),
      blocks: cleanedBlocks
    });
  }

  if (building) {
    const staticBlogImages = import.meta.glob(
      '/static/blog/*.{avif,gif,heif,jpeg,jpg,png,tiff,webp,svg}',
      {
        eager: true,
        query: {
          enhanced: true
        }
      }
    );
    for (const post of posts) {
      for (const block of post.blocks) {
        if (block.type === 'image') {
          block.url = staticBlogImages[`/static/blog/${block.id}.png`].default;
        }
        delete block.id;
      }
    }
  }

  return posts;
};
