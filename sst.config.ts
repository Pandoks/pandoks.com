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
        cloudflare: '6.10.0',
        github: '6.7.2',
        hcloud: { token: process.env.HCLOUD_TOKEN, version: '1.24.0' },
        tailscale: '0.24.0'
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
      import('./infra/vps/vps')
    ]);
    return imports.reduce((acculumator, importResult: any) => {
      if (importResult.outputs) {
        return { ...acculumator, ...importResult.outputs };
      }
      return acculumator;
    }, {});
  }
});
