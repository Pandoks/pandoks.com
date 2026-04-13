import { dev } from '$app/environment';
import { NOTION_API_KEY, BLOG_NOTION_DATABASE_ID } from '$env/static/private';
import {
  Client,
  isFullDatabase,
  isFullPage,
  type BlockObjectResponse,
  type RichTextItemResponse
} from '@notionhq/client';
import { getImageExtensionFromSignedUrlImage } from './utils';
import { SUPPORTED_LANGUAGES } from './highlight';

export const notion = new Client({
  auth: NOTION_API_KEY,
  notionVersion: '2026-03-11'
});

export const blogDataSourceIdPromise = notion.databases
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

function minimizeRichText(text: RichTextItemResponse) {
  return {
    plain_text: text.plain_text,
    annotations: text.annotations,
    href: text.href
  };
}

export const minimizeNotionBlockData = async (block: BlockObjectResponse) => {
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
      return {
        type: block.type,
        texts: richText.map(minimizeRichText)
      };
    }
    case 'image': {
      const imageData = block.image;
      const imageUrl = imageData.type === 'file' ? imageData.file.url : imageData.external.url;
      if (dev) return { type: block.type, url: imageUrl };

      const extension = await getImageExtensionFromSignedUrlImage(imageUrl);
      return {
        type: block.type,
        url: `${block.id}${extension}`
      };
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

export const getAllBlogTitles = async () => {
  const titles: string[] = [];
  let cursor;
  const dataSourceId = await blogDataSourceIdPromise;

  do {
    const pageResponse = await notion.dataSources.query({
      data_source_id: dataSourceId,
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
      if (!isFullPage(page)) continue;

      const titleProperty = page.properties['Title'];
      if (titleProperty?.type !== 'title') continue;

      const title = titleProperty.title[0]?.plain_text;
      if (title) titles.push(title);
    }

    cursor = pageResponse.next_cursor ?? undefined;
  } while (cursor);

  return titles;
};
