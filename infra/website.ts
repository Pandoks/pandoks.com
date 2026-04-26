import { secrets } from './secrets';
import { domain } from './dns';

new sst.x.DevCommand('DevWebsite', {
  dev: {
    title: 'WebsiteDev',
    command: 'pnpm run dev',
    autostart: false,
    directory: 'apps/web'
  }
});
export const staticWebsite = new sst.cloudflare.StaticSite('StaticWebsite', {
  path: 'apps/web',
  build: {
    command: 'pnpm build',
    output: 'build'
  },
  domain,
  environment: {
    NOTION_API_KEY: secrets.notion.ApiKey.value,
    BLOG_NOTION_DATABASE_ID: '20f1bb259e4b804ba24be1ceebf4c761'
  },
  assets: {
    fileOptions: [
      {
        files: '**',
        cacheControl: 'max-age=0,no-cache,no-store,must-revalidate'
      },
      {
        files: ['**/*.js', '**/*.css'],
        cacheControl: 'max-age=31536000,public,immutable'
      },
      {
        files: 'fonts/**',
        cacheControl: 'max-age=31536000,public,immutable'
      },
      {
        files: 'favicon/**',
        cacheControl: 'max-age=31536000,public,immutable'
      {
        files: '**/__data.json',
        cacheControl: 'max-age=3600,public'
      }
    ]
  }
});
