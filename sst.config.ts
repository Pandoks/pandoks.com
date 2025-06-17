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
        cloudflare: '6.3.0',
        github: '6.7.2'
      }
    };
  },
  async run() {
    let outputs = {};
    const { readdirSync } = await import('fs');
    for (const sst of readdirSync('./infra/')) {
      const result = await import('./infra/' + sst);
      if (result.output) {
        Object.assign(outputs, result.output);
      }
    }
    return outputs;
  }
});
