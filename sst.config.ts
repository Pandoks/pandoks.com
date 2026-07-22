/// <reference path="./.sst/platform/config.d.ts" />
import { OVH_ACCOUNTS } from './infra/cluster/config';

export default $config({
  app(input) {
    return {
      name: 'personal',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: {
          region: 'us-west-1',
          profile:
            process.env.GITHUB_ACTIONS || process.env.AWS_ACCESS_KEY_ID ? undefined : 'Personal'
        },
        cloudflare: '6.15.0',
        github: '6.12.1',
        'ovhcloud/pulumi-ovh': {
          endpoint: 'ovh-us',
          applicationKey: OVH_ACCOUNTS.us.applicationKey,
          applicationSecret: process.env.OVH_APPLICATION_SECRET,
          consumerKey: process.env.OVH_CONSUMER_KEY,
          version: '2.17.0'
        },
        tailscale: {
          oauthClientId: process.env.TAILSCALE_OAUTH_CLIENT_ID,
          oauthClientSecret: process.env.TAILSCALE_OAUTH_CLIENT_SECRET,
          version: '0.27.0'
        }
      }
    };
  },
  async run() {
    // NOTE: for some reason, dynamic imports don't work well so just manually import
    const imports = await Promise.all([
      import('./infra/secrets'),
      import('./infra/aws'),
      import('./infra/dns'),
      import('./infra/api'),
      import('./infra/cloudflare'),
      import('./infra/storage'),
      import('./infra/github'),
      import('./infra/website'),
      import('./infra/tailscale'),
      import('./infra/cluster/cluster'),
      import('./infra/kubernetes'),
      import('./infra/dev'),
      import('./infra/runner/runner')
    ]);
    return imports.reduce((acculumator, importResult: any) => {
      if (importResult.outputs) {
        return { ...acculumator, ...importResult.outputs };
      }
      return acculumator;
    }, {});
  }
});
