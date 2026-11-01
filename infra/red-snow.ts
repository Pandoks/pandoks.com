import { cloudflareAccountId, isProduction } from './dns';
import { secrets } from './secrets';

// RED-SNOW (Blackfrost-AI GLM-5.3-Flash fine-tune) runs on a DeepInfra "Custom LLM"
// deployment (2x H200, NVFP4, 1M context). DeepInfra has no SST/Pulumi provider, so the
// deployment itself is created out-of-band with `pnpm red-snow up`; this module only owns
// the autoscaler that toggles it.
//
// A single Cloudflare Worker:
//   - POST /wake (bearer-protected)  -> create the deployment or scale it to 1
//   - cron every 5 min               -> scale to 0 after it has been idle (see scaler source)
//
// Gated on production so only the `main` deploy owns the scaler: two stages sharing one
// DeepInfra deployment would fight over its min_instances.
let redSnowScalerUrl: $util.Output<string | undefined> | undefined;

if (isProduction) {
  const scaler = new sst.cloudflare.Worker('RedSnowScaler', {
    handler: 'apps/functions/src/api/deepinfra/red-snow-scaler.ts',
    url: true,
    link: [secrets.deepinfra.ApiKey, secrets.deepinfra.RedSnowWakeToken]
  });

  new cloudflare.WorkersCronTrigger('RedSnowScalerTrigger', {
    accountId: cloudflareAccountId,
    scriptName: scaler.nodes.worker.scriptName,
    schedules: [{ cron: '*/5 * * * *' }]
  });

  // The workers.dev URL that a Claude Code SessionStart hook or shell alias POSTs /wake to.
  redSnowScalerUrl = scaler.url;
}

export const outputs = { redSnowScalerUrl };
