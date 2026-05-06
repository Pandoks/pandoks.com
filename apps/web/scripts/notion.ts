import https from 'https';
import fs, { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import {
  Client,
  isFullBlock,
  isFullDatabase,
  isFullPage,
  type BlockObjectResponse,
  type RichTextItemResponse
} from '@notionhq/client';
import { getSlugFromBlogTitle } from '../src/lib/utils.ts';
import { SUPPORTED_LANGUAGES } from '../src/lib/highlight.ts';

const getImageExtensionFromMime = (mime: string | undefined | null): string => {
  if (!mime) {
    throw new Error('No mime type provided');
  }

  switch (mime.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpeg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    case 'image/bmp':
      return '.bmp';
    case 'image/tiff':
      return '.tiff';
    case 'image/x-icon':
      return '.ico';
    default:
      throw new Error(`Unsupported image mime type: ${mime}`);
  }
};

const getImageExtensionFromSignedUrlImage = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} - ${response.statusText}`);
  }

  const contentType = response.headers.get('Content-Type');
  return getImageExtensionFromMime(contentType);
};

const downloadSignedUrlImage = async ({
  url,
  dir,
  name
}: {
  url: string;
  dir: string;
  name: string;
}): Promise<string> => {
  await fs.promises.mkdir(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download image: ${url}`));
          return;
        }

        const contentType = response.headers['content-type'];
        const extension = getImageExtensionFromMime(contentType);

        const outputPath = join(dir, `${name}${extension}`);
        const file = fs.createWriteStream(outputPath);
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log(`Downloaded ${basename(outputPath)}`);
          resolve(outputPath);
        });

        file.on('error', (error) => {
          fs.unlink(outputPath, () => {
            reject(new Error(`File writing error: ${error.message}`));
          });
        });
      })
      .on('error', (error) => {
        reject(new Error(`Request error: ${error.message}`));
      });
  });
};

const NOTION_API_KEY = process.env.SST_RESOURCE_NotionApiKey
  ? JSON.parse(process.env.SST_RESOURCE_NotionApiKey).value
  : process.env.NOTION_API_KEY;
const BLOG_NOTION_DATABASE_ID = process.env.SST_RESOURCE_Notion
  ? JSON.parse(process.env.SST_RESOURCE_Notion).blogDatabaseId
  : process.env.BLOG_NOTION_DATABASE_ID;
if (!NOTION_API_KEY || !BLOG_NOTION_DATABASE_ID) {
  throw new Error('NOTION_API_KEY and BLOG_NOTION_DATABASE_ID required');
}

const BLOG_CONTENT_DIR = join(process.cwd(), 'src/lib/blog');
const IMAGE_DIR = join(BLOG_CONTENT_DIR, 'images');

type ImageDownload = { url: string; id: string };

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

const notion = new Client({
  auth: NOTION_API_KEY,
  notionVersion: '2026-03-11'
});

const blogDataSourceIdPromise = notion.databases
  .retrieve({ database_id: BLOG_NOTION_DATABASE_ID })
  .then((database) => {
    if (!isFullDatabase(database)) {
      throw new Error(`Could not retrieve full database ${BLOG_NOTION_DATABASE_ID}`);
    }
    const dataSourceId = database.data_sources[0]?.id;
    if (!dataSourceId) {
      throw new Error(`Could not find a data source for database ${BLOG_NOTION_DATABASE_ID}`);
    }
    return dataSourceId;
  });

const minimizeRichText = (text: RichTextItemResponse) => ({
  plain_text: text.plain_text,
  annotations: text.annotations,
  href: text.href
});

const minimizeBlock = async (block: BlockObjectResponse) => {
  switch (block.type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'paragraph': {
      const richText =
        block.type === 'paragraph'
          ? block.paragraph.rich_text
          : block.type === 'heading_1'
            ? block.heading_1.rich_text
            : block.type === 'heading_2'
              ? block.heading_2.rich_text
              : block.heading_3.rich_text;
      if (!richText.length) return { type: 'break' };
      return { type: block.type, texts: richText.map(minimizeRichText) };
    }
    case 'image': {
      const imageData = block.image;
      const imageUrl = imageData.type === 'file' ? imageData.file.url : imageData.external.url;
      const extension = await getImageExtensionFromSignedUrlImage(imageUrl);
      return { type: block.type, filename: `${block.id}${extension}` };
    }
    case 'code': {
      const codeBlock = block.code;
      if (!SUPPORTED_LANGUAGES.includes(codeBlock.language)) {
        throw new Error(`Unsupported language: ${codeBlock.language}`);
      }
      return {
        type: block.type,
        code: codeBlock.rich_text[0]?.plain_text ?? '',
        language: codeBlock.language
      };
    }
    default:
      throw new Error(`Unsupported block type: ${block.type}`);
  }
};

const getPageBlocks = async (pageId: string) => {
  const processingBlocks = [];
  const imageDownloads: ImageDownload[] = [];
  let blockCursor;
  do {
    const blockResponse = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: blockCursor,
      page_size: 100
    });

    for (const block of blockResponse.results) {
      if (!isFullBlock(block) || block.in_trash || block.type === 'bookmark') continue;
      processingBlocks.push(minimizeBlock(block));
      if (block.type === 'image') {
        const url = block.image.type === 'file' ? block.image.file.url : block.image.external.url;
        imageDownloads.push({ url, id: block.id });
      }
    }

    blockCursor = blockResponse.next_cursor ?? undefined;
  } while (blockCursor);

  const blocks = await Promise.all(processingBlocks);
  return { blocks, imageDownloads };
};

const getPublishedPages = async () => {
  const pages: { pageId: string; title: string; createdTime: Date }[] = [];
  let pageCursor;
  const dataSourceId = await blogDataSourceIdPromise;

  do {
    const pageResponse = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: { property: 'Publish', checkbox: { equals: true } },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      start_cursor: pageCursor
    });

    for (const page of pageResponse.results) {
      if (!isFullPage(page)) continue;
      const titleProperty = page.properties['Title'];
      if (titleProperty?.type !== 'title') continue;
      const title = titleProperty.title[0]?.plain_text;
      if (!title) continue;
      pages.push({
        pageId: page.id,
        title,
        createdTime: new Date(page.created_time)
      });
    }

    pageCursor = pageResponse.next_cursor ?? undefined;
  } while (pageCursor);

  return pages;
};

const syncNotion = async () => {
  mkdirSync(BLOG_CONTENT_DIR, { recursive: true });
  mkdirSync(IMAGE_DIR, { recursive: true });

  const pages = await getPublishedPages();
  console.log(`Found ${pages.length} published blog pages`);

  const currentSlugs = new Set<string>();
  const allImageDownloads: ImageDownload[] = [];

  await Promise.all(
    pages.map(async (page) => {
      const slug = getSlugFromBlogTitle(page.title);
      currentSlugs.add(slug);

      const { blocks, imageDownloads } = await getPageBlocks(page.pageId);
      allImageDownloads.push(...imageDownloads);

      const createdTime = `${MONTHS[page.createdTime.getMonth()]} ${page.createdTime.getFullYear()}`;
      const post = { title: page.title, createdTime, blocks };

      const filePath = join(BLOG_CONTENT_DIR, `${slug}.json`);
      writeFileSync(filePath, JSON.stringify(post, null, 2) + '\n');
      console.log(`Wrote ${slug}.json`);
    })
  );

  const writtenImageFiles = new Set<string>();
  await Promise.all(
    allImageDownloads.map(async ({ url, id }) => {
      const path = await downloadSignedUrlImage({ url, dir: IMAGE_DIR, name: id });
      writtenImageFiles.add(basename(path));
    })
  );

  for (const fileName of readdirSync(BLOG_CONTENT_DIR)) {
    if (!fileName.endsWith('.json')) continue;
    const slug = fileName.replace(/\.json$/, '');
    if (!currentSlugs.has(slug)) {
      unlinkSync(join(BLOG_CONTENT_DIR, fileName));
      console.log(`Removed stale ${slug}.json`);
    }
  }

  for (const fileName of readdirSync(IMAGE_DIR)) {
    if (!writtenImageFiles.has(fileName)) {
      unlinkSync(join(IMAGE_DIR, fileName));
      console.log(`Removed stale image ${fileName}`);
    }
  }
};

await syncNotion();
