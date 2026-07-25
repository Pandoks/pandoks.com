/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: 'personal',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: { region: 'us-west-1' },
        cloudflare: '6.15.0',
        github: '6.12.1',
        hcloud: '1.32.1',
        // NOTE: config set here lands under '@ovhcloud/pulumi-ovh:*' (SST namespaces by package
        // name) but the provider reads 'ovh:*', so credentials come from the OVH_* env vars
        '@ovhcloud/pulumi-ovh': '2.17.0',
        tailscale: '0.27.0'
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
      import('./infra/vps/vps'),
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
