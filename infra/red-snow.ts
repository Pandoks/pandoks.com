import { cloudflareAccountId, isProduction } from './dns';
import { secrets } from './secrets';

// DeepInfra has no SST/Pulumi provider, so the RED-SNOW deployment is created and toggled by this
// Worker (see red-snow-scaler.ts) rather than declared as a resource.
// NOTE: production-gated so only the `main` deploy owns the scaler; two stages sharing one DeepInfra
// deployment would fight over its min_instances.
let redSnowScalerUrl: $util.Output<string | undefined> | undefined;

if (isProduction) {
  // Activity heartbeat, last-applied spec hash, and running-since timestamp for the scaler.
  const scalerState = new sst.cloudflare.Kv('RedSnowScalerState');

  const scaler = new sst.cloudflare.Worker('RedSnowScaler', {
    handler: 'apps/functions/src/api/deepinfra/red-snow-scaler.ts',
    url: true,
    link: [scalerState, secrets.deepinfra.ApiKey, secrets.deepinfra.RedSnowWakeToken]
  });

  new cloudflare.WorkersCronTrigger('RedSnowScalerTrigger', {
    accountId: cloudflareAccountId,
    scriptName: scaler.nodes.worker.scriptName,
    schedules: [{ cron: '*/5 * * * *' }]
  });

  redSnowScalerUrl = scaler.url;
}

export const outputs = { redSnowScalerUrl };
