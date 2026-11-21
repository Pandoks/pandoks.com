import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import * as github from '@pulumi/github';
import * as hcloud from '@pulumi/hcloud';
import * as ovh from '@ovhcloud/pulumi-ovh';
import * as tailscale from '@pulumi/tailscale';
import { secrets } from './secrets.ts';

// NOTE: explicit providers so no ambient token is used; disabled defaults fail anything missed
const providers: Record<string, pulumi.ProviderResource> = {
  cloudflare: new cloudflare.Provider('Cloudflare', { apiToken: secrets.cloudflare.ApiKey }),
  github: new github.Provider('Github', { token: secrets.github.PersonalAccessToken }),
  hcloud: new hcloud.Provider('Hetzner', { token: secrets.hetzner.ApiKey }),
  ovh: new ovh.Provider('Ovh', {
    endpoint: 'ovh-us',
    applicationKey: 'edf9a4672d28e3c7',
    applicationSecret: secrets.ovh.ApplicationSecret,
    consumerKey: secrets.ovh.ConsumerKey
  }),
  tailscale: new tailscale.Provider('Tailscale', {
    oauthClientId: secrets.tailscale.OauthClientId,
    oauthClientSecret: secrets.tailscale.OauthClientSecret
  })
};

const isProduction = pulumi.getStack() === 'production';

pulumi.runtime.registerResourceTransform(({ type, props, opts }) => ({
  props,
  opts: {
    ...opts,
    protect: opts.protect ?? (isProduction ? true : undefined),
    provider: opts.provider ?? providers[type.split(':')[0]]
  }
}));
pulumi.runtime.registerInvokeTransform(({ token, args, opts }) => ({
  args,
  opts: { ...opts, provider: opts.provider ?? providers[token.split(':')[0]] }
}));
