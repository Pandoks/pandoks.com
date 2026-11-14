import { env } from 'cloudflare:workers';
import type { NotionWebhookEvent } from './webhook';

const GITHUB_NOTION_SYNC_URL =
  'https://api.github.com/repos/Pandoks/pandoks.com/actions/workflows/sync-notion.yaml/dispatches';

// NOTE: notion UUIDs are inconsistent with the same resource. sometimes dashes and sometimes not
const normalizeNotionId = (id: string) => id.replaceAll('-', '').toLowerCase();

export const handleNotionBlogSync = async (event: NotionWebhookEvent) => {
  if (event.entity.type !== 'page') return;

  const parent = (event.data as { parent?: { database_id?: string } }).parent;
  if (
    !parent?.database_id ||
    normalizeNotionId(parent.database_id) !== env.NOTION_BLOG_DATABASE_ID
  ) {
    return;
  }

  const githubResponse = await fetch(GITHUB_NOTION_SYNC_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `token ${env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pandoks.com'
    },
    body: JSON.stringify({ ref: 'main' })
  });

  if (!githubResponse.ok) {
    throw new Error(`GitHub sync dispatch failed: ${githubResponse.status}`);
  }
};
