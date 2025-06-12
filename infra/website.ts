export const staticWebsite = new sst.cloudflare.StaticSite('StaticWebsite', {
  path: 'apps/web',
  build: {
    command: 'pnpm run build',
    output: 'dist'
  },
  domain: 'pandoks.com'
});
