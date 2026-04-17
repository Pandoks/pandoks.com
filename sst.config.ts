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
          profile:
            process.env.GITHUB_ACTIONS || process.env.AWS_ACCESS_KEY_ID ? undefined : 'Personal'
        },
        cloudflare: '6.13.0',
        github: '6.12.1',
        hcloud: { token: process.env.HCLOUD_TOKEN, version: '1.32.1' },
        tailscale: { apiKey: process.env.TAILSCALE_API_KEY, version: '0.27.0' }
      }
    };
  },
  async run() {
    // NOTE: for some reason, dynamic imports don't work well so just manually import
    let imports = await Promise.all([
      import('./infra/dns'),
      import('./infra/api'),
      import('./infra/cloudflare'),
      import('./infra/storage'),
      import('./infra/github'),
      import('./infra/secrets'),
      import('./infra/website'),
      import('./infra/tailscale'),
      import('./infra/vps/vps'),
      import('./infra/kubernetes'),
      import('./infra/dev')
    ]);
    // WARNING: sandboxes should only be imported in the pandoks stage
    if ($app.stage === 'pandoks') {
      imports.push(await Promise.all([import('./infra/sandbox/apartment-search')]));
    }
    return imports.reduce((acculumator, importResult: any) => {
      if (importResult.outputs) {
        return { ...acculumator, ...importResult.outputs };
      }
      return acculumator;
    }, {});
  }
});
