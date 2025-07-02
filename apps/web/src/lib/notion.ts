import { dev } from '$app/environment';
import { NOTION_API_KEY } from '$env/static/private';
import { Client } from '@notionhq/client';

export const notion = new Client({
  auth: NOTION_API_KEY
});

export const minimizeNotionBlockData = (block: any) => {
  switch (block.type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'paragraph':
      return {
        type: block[block.type].rich_text[0].href ? 'link' : block.type,
        text: block[block.type].rich_text[0].plain_text
      };
    case 'image':
      return {
        type: block.type,
        id: dev ? block[block.type].file.url : block.id
      };
    default:
      throw new Error(`Unsupported block type: ${block.type}`);
  }
};
