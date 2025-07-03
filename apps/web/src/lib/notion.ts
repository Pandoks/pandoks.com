import { dev } from '$app/environment';
import { NOTION_API_KEY } from '$env/static/private';
import { Client } from '@notionhq/client';
import { getImageExtensionFromSignedUrlImage } from './utils';

export const notion = new Client({
  auth: NOTION_API_KEY
});

export const minimizeNotionBlockData = async (block: any) => {
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
      const imageUrl = block[block.type].file.url;
      if (dev) {
        return { type: block.type, url: imageUrl };
      }
      const extension = await getImageExtensionFromSignedUrlImage(imageUrl);
      return {
        type: block.type,
        url: `${block.id}${extension}`
      };
    default:
      throw new Error(`Unsupported block type: ${block.type}`);
  }
};
