import { NOTION_DATABASE_ID } from '$env/static/private';
import { notion } from './notion';
import { downloadSignedUrlImage } from './utils';

export const downloadBlogImages = async () => {
  let allPublishedPages = [];
  let pageCursor;
  do {
    const pagesResponse = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      filter: {
        property: 'Publish',
        checkbox: {
          equals: true
        }
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      start_cursor: pageCursor
    });

    allPublishedPages.push(...pagesResponse.results);
    pageCursor = pagesResponse.next_cursor;
  } while (pageCursor);

  let imageDownloads = [];
  for (const page of allPublishedPages) {
    let pageCursor;
    do {
      const blockResponse = await notion.blocks.children.list({
        block_id: page.id,
        start_cursor: pageCursor,
        page_size: 100
      });
      const imageBlocks = blockResponse.results.filter(
        (block) => !block.archived && !block.in_trash && block.type === 'image'
      );

      for (const block of imageBlocks) {
        imageDownloads.push(
          downloadSignedUrlImage({
            url: block[block.type].file.url,
            dir: '/blog-images',
            name: block.id
          })
        );
      }

      pageCursor = blockResponse.next_cursor;
    } while (pageCursor);
  }

  await Promise.all(imageDownloads);
};

await Promise.all([downloadBlogImages()]);
