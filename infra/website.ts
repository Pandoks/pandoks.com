import { secrets } from './secrets';

export const staticWebsite = new sst.cloudflare.StaticSite('StaticWebsite', {
  path: 'apps/web',
  build: {
    command: 'pnpm run build',
    output: 'build'
  },
  domain: 'pandoks.com',
  environment: {
    NOTION_API_KEY: secrets.NotionApiKey.value,
    NOTION_DATABASE_ID: '20f1bb259e4b804ba24be1ceebf4c761'
  }
});
