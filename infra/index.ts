import { outputs as secretOutputs } from './secrets.ts';
import { outputs as dnsOutputs } from './dns.ts';
import { outputs as awsOutputs } from './aws.ts';
import { outputs as apiOutputs } from './api.ts';
import { outputs as cloudflareOutputs } from './cloudflare.ts';
import { outputs as storageOutputs } from './storage.ts';
import './github.ts';
import './website.ts';
import { outputs as tailscaleOutputs } from './tailscale.ts';
import { outputs as vpsOutputs } from './vps/vps.ts';
import { outputs as kubernetesOutputs } from './kubernetes.ts';
import './dev.ts';
import './runner/runner.ts';

export default {
  ...secretOutputs,
  ...dnsOutputs,
  ...awsOutputs,
  ...apiOutputs,
  ...cloudflareOutputs,
  ...storageOutputs,
  ...tailscaleOutputs,
  ...vpsOutputs,
  ...kubernetesOutputs
};
