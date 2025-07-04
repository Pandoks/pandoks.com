import { BLOG_NOTION_DATABASE_ID } from '$env/static/private';
import { getAllBlogTitles, notion } from './notion';
import { downloadSignedUrlImage } from './utils';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const WEB_DIR = process.cwd();
const TEMP_DIR = join(WEB_DIR, '.temp');
mkdirSync(TEMP_DIR, { recursive: true });

export const downloadBlogImages = async () => {
  let allPublishedPages = [];
  let pageCursor;
  do {
    const pagesResponse = await notion.databases.query({
      database_id: BLOG_NOTION_DATABASE_ID,
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
