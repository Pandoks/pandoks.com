import { NOTION_API_KEY } from '$env/static/private';
import { Client } from '@notionhq/client';

export const notion = new Client({
  auth: NOTION_API_KEY
});
