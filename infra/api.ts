import { secrets } from './secrets';
import { domain } from './dns';

export const blogApi = new sst.cloudflare.Worker('blogApi', {
  handler: 'apps/functions/src/api/index.ts',
  domain: `api.${domain}`,
  url: true,
  link: [secrets.notion.BlogDeployAuth]
});

export const outputs = {
  blogApi: blogApi.url
};
