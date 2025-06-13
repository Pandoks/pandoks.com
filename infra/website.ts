import { secrets } from './secrets';

export const staticWebsite = new sst.cloudflare.StaticSite('StaticWebsite', {
  path: 'apps/web',
  build: {
    command: 'pnpm run build',
    output: 'build'
  },
  domain: 'pandoks.com',
  environment: {
    NOTION_API_KEY: secrets.NotionApiKey.value
  }
});
