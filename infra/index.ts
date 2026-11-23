import './providers.ts';
import { outputs as secretOutputs } from './secrets.ts';
import { isCoreStack } from './dns.ts';
import { outputs as apiOutputs } from './api.ts';
import { outputs as githubOutputs } from './github.ts';
import './website.ts';
import './dev.ts';

let coreOutputs: Record<string, unknown> = {};
if (isCoreStack) {
  const [vps, kubernetes] = await Promise.all([
    import('./vps/vps.ts'),
    import('./kubernetes.ts'),
    import('./cloudflare.ts'),
    import('./storage.ts'),
    import('./runner/runner.ts')
  ]);
  coreOutputs = {
    ...vps.outputs,
    ...kubernetes.outputs
  };
}

export default {
  ...secretOutputs,
  ...apiOutputs,
  ...githubOutputs,
  ...coreOutputs
};
