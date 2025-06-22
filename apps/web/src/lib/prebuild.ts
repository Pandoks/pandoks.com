import { NOTION_DATABASE_ID } from '$env/static/private';
import { getPageAndBlocksData } from './notion';
import { downloadSignedUrlImage } from './utils';

export const downloadBlogImages = async () => {
  const posts = await getPageAndBlocksData({
    databaseId: NOTION_DATABASE_ID,
    filter: {
      property: 'Publish',
      checkbox: {
        equals: true
      }
    }
  });
  let imageDownloads = [];
  for (const post of posts) {
    for (const block of post.blocks) {
      if (block.type === 'image') {
        imageDownloads.push(
          downloadSignedUrlImage({
            url: block[block.type].file.url,
            dir: '/blog',
            name: block.id
          })
        );
      }
    }
  }
  await Promise.all(imageDownloads);
};

await Promise.all([downloadBlogImages()]);
