import { Resource } from 'sst';
import type { NotionWebhookEvent } from './webhook';

// NOTE: notion UUIDs are inconsistent with the same resource. sometimes dashes and sometimes not
const normalizeNotionId = (id: string) => id.replaceAll('-', '').toLowerCase();

export const handleNotionBlogSync = async (event: NotionWebhookEvent) => {
  if (event.entity.type !== 'page') return;

  const parent = (event.data as { parent?: { database_id?: string } }).parent;
  if (
    !parent?.database_id ||
    normalizeNotionId(parent.database_id) !== process.env.BLOG_NOTION_DATABASE_ID!
  ) {
    return;
  }

  const githubResponse = await fetch(process.env.GITHUB_NOTION_SYNC_URL!, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `token ${Resource.GithubPersonalAccessToken.value}`,
      'Content-Type': 'application/json',
      'User-Agent': process.env.DOMAIN!
    },
    body: JSON.stringify({ ref: 'main' })
  });

  if (!githubResponse.ok) {
    throw new Error(`GitHub sync dispatch failed: ${githubResponse.status}`);
  }
};
