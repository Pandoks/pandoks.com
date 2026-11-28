import './providers.ts';
import { isCoreStack } from '@pandoks.com/infra/stack';
import { outputs as secretOutputs } from './secrets.ts';
import { outputs as dnsOutputs } from './dns.ts';
import { outputs as awsOutputs } from './aws.ts';
import { outputs as apiOutputs } from './api.ts';
import { outputs as transcribeOutputs } from './transcribe.ts';
import './github.ts';
import './website.ts';
import { outputs as tailscaleOutputs } from './tailscale.ts';
import { outputs as kubernetesOutputs } from './kubernetes.ts';
import './dev.ts';

let coreOutputs: Record<string, unknown> = {};
if (isCoreStack) {
  const [cloudflare, storage, vps] = await Promise.all([
    import('./cloudflare.ts'),
    import('./storage.ts'),
    import('./vps/vps.ts'),
    import('./runner/runner.ts')
  ]);
  coreOutputs = {
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
  ...transcribeOutputs,
  ...tailscaleOutputs,
  ...kubernetesOutputs,
  ...coreOutputs
};
