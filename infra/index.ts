import './providers.ts';
import { outputs as secretOutputs } from './secrets.ts';
import { isSharedStage, outputs as dnsOutputs } from './dns.ts';
import { outputs as awsOutputs } from './aws.ts';
import { outputs as apiOutputs } from './api.ts';
import './github.ts';
import './website.ts';
import { outputs as tailscaleOutputs } from './tailscale.ts';
import { outputs as kubernetesOutputs } from './kubernetes.ts';
import './dev.ts';

let sharedOutputs: Record<string, unknown> = {};
if (isSharedStage) {
  const [cloudflare, storage, vps] = await Promise.all([
    import('./cloudflare.ts'),
    import('./storage.ts'),
    import('./vps/vps.ts'),
    import('./runner/runner.ts')
  ]);
  sharedOutputs = {
    ...cloudflare.outputs,
    ...storage.outputs,
    ...vps.outputs
  };
}

export default {
  ...secretOutputs,
  ...dnsOutputs,
  ...awsOutputs,
  ...apiOutputs,
  ...tailscaleOutputs,
  ...kubernetesOutputs,
  ...sharedOutputs
};
