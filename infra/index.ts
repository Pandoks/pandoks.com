import { outputs as secretOutputs } from './secrets.ts';
import { outputs as apiOutputs } from './api.ts';
import './cloudflare.ts';
import { outputs as githubOutputs } from './github.ts';
import './website.ts';
import { outputs as vpsOutputs } from './vps/vps.ts';
import { outputs as kubernetesOutputs } from './kubernetes.ts';
import './dev.ts';
import './runner/runner.ts';

export default {
  ...secretOutputs,
  ...apiOutputs,
  ...githubOutputs,
  ...vpsOutputs,
  ...kubernetesOutputs
};
