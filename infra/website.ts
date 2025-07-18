import { secrets } from './secrets';
import { domain } from './dns';

export const staticWebsite = new sst.cloudflare.StaticSite('StaticWebsite', {
  path: 'apps/web',
  build: {
    command: 'pnpm run build',
    output: 'build'
  },
  domain,
  environment: {
    NOTION_API_KEY: secrets.notion.ApiKey.value,
    BLOG_NOTION_DATABASE_ID: '20f1bb259e4b804ba24be1ceebf4c761'
  }
});
