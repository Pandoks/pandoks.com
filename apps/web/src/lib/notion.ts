import { dev } from '$app/environment';
import { NOTION_API_KEY, BLOG_NOTION_DATABASE_ID } from '$env/static/private';
import { Client } from '@notionhq/client';
import { getImageExtensionFromSignedUrlImage } from './utils';

export const notion = new Client({
  auth: NOTION_API_KEY
});

const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'json',
  'go',
  'bash',
  'yaml',
  'dockerfile',
  'css',
  'html',
  'xml',
  'python',
  'shell'
];

export const minimizeNotionBlockData = async (block: any) => {
  const blockType = block.type;
  const blockData = block[blockType];
  switch (block.type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'paragraph':
      if (!blockData.rich_text.length) {
        return { type: 'break' };
      }
      return {
        type: blockType,
        texts: blockData.rich_text.map((text) => ({
          plain_text: text.plain_text,
          annotations: text.annotations,
          href: text.href
        }))
      };
    case 'image':
      const imageUrl = blockData.file.url;
      if (dev) {
        return { type: blockType, url: imageUrl };
      }
      const extension = await getImageExtensionFromSignedUrlImage(imageUrl);
      return {
        type: blockType,
        url: `${block.id}${extension}`
      };
    case 'code':
      if (!SUPPORTED_LANGUAGES.includes(blockData.language)) {
        throw new Error(`Unsupported language: ${blockData.language}`);
      }
      return {
        type: blockType,
        code: blockData.rich_text[0].plain_text,
        language: blockData.language
      };
    default:
      throw new Error(`Unsupported block type: ${block.type}`);
  }
};

export const getAllBlogTitles = async () => {
  let titles = [];
  let cursor;

  do {
    const pageResponse = await notion.databases.query({
      database_id: BLOG_NOTION_DATABASE_ID,
      filter: {
        property: 'Publish',
        checkbox: {
          equals: true
        }
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      start_cursor: cursor
    });

    for (const page of pageResponse.results) {
      titles.push(page.properties.Title.title[0].plain_text as string);
    }

    // will be null if there are no more pages
    cursor = pageResponse.next_cursor;
  } while (cursor);

  return titles;
};
