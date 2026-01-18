/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: 'personal',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: {
          profile: process.env.GITHUB_ACTIONS ? undefined : 'Personal'
        },
        cloudflare: '6.12.0',
        github: '6.7.2',
        hcloud: { token: process.env.HCLOUD_TOKEN, version: '1.24.0' },
        tailscale: { apiKey: process.env.TAILSCALE_API_KEY, version: '0.24.0' }
      }
    };
  },
  async run() {
    // NOTE: for some reason, dynamic imports don't work well so just manually import
    const imports = await Promise.all([
      import('./infra/api'),
      import('./infra/dns'),
      import('./infra/cloudflare'),
      import('./infra/github'),
      import('./infra/secrets'),
      import('./infra/website'),
      import('./infra/tailscale'),
      import('./infra/vps/vps'),
      import('./infra/dev')
    ]);
    return imports.reduce((acculumator, importResult: any) => {
      if (importResult.outputs) {
        return { ...acculumator, ...importResult.outputs };
      }
      return acculumator;
    }, {});
  }
});
