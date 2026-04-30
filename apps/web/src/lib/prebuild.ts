import { blogDataSourceIdPromise, getAllBlogTitles, notion } from './notion';
import { isFullBlock, isFullPage } from '@notionhq/client';
import { downloadSignedUrlImage } from './utils';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const WEB_DIR = process.cwd();
const TEMP_DIR = join(WEB_DIR, '.temp');
mkdirSync(TEMP_DIR, { recursive: true });

export const downloadBlogImages = async () => {
  let allPublishedPageIds: string[] = [];
  let pageCursor;
  const dataSourceId = await blogDataSourceIdPromise;
  do {
    const pagesResponse = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        property: 'Publish',
        checkbox: {
          equals: true
        }
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      start_cursor: pageCursor
    });

    for (const page of pagesResponse.results) {
      if (!isFullPage(page)) continue;
      allPublishedPageIds.push(page.id);
    }
    pageCursor = pagesResponse.next_cursor ?? undefined;
  } while (pageCursor);

  let imageDownloads = [];
  for (const pageId of allPublishedPageIds) {
    let blockCursor;
    do {
      const blockResponse = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: blockCursor,
        page_size: 100
      });

      for (const block of blockResponse.results) {
        if (!isFullBlock(block) || block.in_trash || block.type !== 'image') continue;

        const imageUrl =
          block.image.type === 'file' ? block.image.file.url : block.image.external.url;
        imageDownloads.push(
          downloadSignedUrlImage({
            url: imageUrl,
            dir: '/blog-images',
            name: block.id
          })
        );
      }

      blockCursor = blockResponse.next_cursor ?? undefined;
    } while (blockCursor);
  }

  await Promise.all(imageDownloads);
};

export const processBlogRoutes = async () => {
  const titles = await getAllBlogTitles();
  console.log(`proccessBlogRoutes: Found ${titles.length} blog titles`);
  if (titles.length) return;

  const blogTitleDir = join(WEB_DIR, 'src', 'routes', 'blog', '[title]');
  const tempBlogDir = join(TEMP_DIR, 'src', 'routes', 'blog');

  mkdirSync(tempBlogDir, { recursive: true });
  execSync(`mv "${blogTitleDir}" "${join(tempBlogDir, '[title]')}"`, { stdio: 'inherit' });
  console.log('processBlogRoutes: Moved blog routes to .temp directory');
};

await Promise.all([downloadBlogImages(), processBlogRoutes()]);
