import * as pulumi from '@pulumi/pulumi';
import { isProduction } from './dns.ts';

const DATA_RESOURCE_TYPES = ['aws:s3/bucket:Bucket', 'cloudflare:index/r2Bucket:R2Bucket'];

// NOTE: production data outlives its code, and `pulumi destroy` fails before deleting anything.
if (isProduction) {
  pulumi.runtime.registerResourceTransform(({ type, props, opts }) =>
    DATA_RESOURCE_TYPES.includes(type)
      ? { props, opts: { ...opts, protect: true, retainOnDelete: true } }
      : undefined
  );
}

// NOTE: imported after the transform is registered, because static imports are hoisted above it.
const modules = await Promise.all([
  import('./secrets.ts'),
  import('./dns.ts'),
  import('./aws.ts'),
  import('./api.ts'),
  import('./cloudflare.ts'),
  import('./storage.ts'),
  import('./github.ts'),
  import('./website.ts'),
  import('./tailscale.ts'),
  import('./vps/vps.ts'),
  import('./kubernetes.ts'),
  import('./dev.ts'),
  import('./runner/runner.ts')
]);

export default Object.fromEntries(
  modules.flatMap((module) => ('outputs' in module ? Object.entries(module.outputs) : []))
);
