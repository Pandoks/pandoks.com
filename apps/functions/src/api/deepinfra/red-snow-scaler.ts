import { Resource } from 'sst';
import deployment from './deployment.json' with { type: 'json' };

// The model's full DeepInfra name is <github-username>/<model_name>.
const FULL_NAME = `Pandoks/${deployment.model_name}`;
const API = 'https://api.deepinfra.com';

// Shut the GPUs off after this many minutes with no traffic. The 5-minute cron
// (infra/red-snow.ts) is what calls scheduled(), so the real granularity is 5 min.
const IDLE_MINUTES = 30;

interface Deployment {
  deploy_id: string;
  model_name: string;
  status: string;
  settings: { min_instances: number; max_instances: number } | null;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${Resource.DeepinfraApiKey.value}`,
    'Content-Type': 'application/json'
  };
}

async function findDeployment(): Promise<Deployment | undefined> {
  const response = await fetch(`${API}/deploy/list`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`deploy/list ${response.status}`);
  const deployments = (await response.json()) as Deployment[];
  return deployments.find((d) => d.model_name === FULL_NAME && d.status !== 'deleted');
}

async function setInstances(deployId: string, min: number) {
  const response = await fetch(`${API}/deploy/${deployId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ settings: { min_instances: min, max_instances: 1 } })
  });
  if (!response.ok) throw new Error(`PUT deploy/${deployId} ${response.status}`);
}

async function wake(): Promise<{ status: string; deploy_id: string }> {
  const existing = await findDeployment();
  if (existing) {
    if (existing.settings?.min_instances !== 1) await setInstances(existing.deploy_id, 1);
    return { status: existing.status, deploy_id: existing.deploy_id };
  }
  const response = await fetch(`${API}/deploy/llm`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ...deployment, settings: { min_instances: 1, max_instances: 1 } })
  });
  if (!response.ok) {
    // A concurrent wake may have created it between the list and this POST; adopt that one.
    const raced = await findDeployment();
    if (raced) return { status: raced.status, deploy_id: raced.deploy_id };
    throw new Error(`deploy/llm ${response.status}: ${await response.text()}`);
  }
  const created = (await response.json()) as Deployment;
  return { status: created.status, deploy_id: created.deploy_id };
}

// One vLLM engine line per ~10s, e.g.
// "... INFO 11-01 06:52:36 [loggers.py:335] Engine 000: Avg prompt throughput: 0.0 tokens/s,
//  Avg generation throughput: 0.0 tokens/s, Running: 0 reqs, ..."
const ENGINE_LINE =
  /(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}).*?Avg prompt throughput: ([\d.]+).*?Avg generation throughput: ([\d.]+).*?Running: (\d+) reqs/g;

interface EngineSample {
  at: number;
  active: boolean;
}

// vLLM logs an engine line roughly every 10s whenever the engine is alive, idle or not.
// A fresh line must be newer than this for the engine to count as "logging right now".
const FRESH_SAMPLE_MS = 120_000;
// Gap larger than this between consecutive samples means the engine stopped and restarted
// (i.e. a scale-to-zero then wake), so the older samples predate the current instance.
const MAX_SAMPLE_GAP_MS = 180_000;

function parseEngineSamples(logText: string, now: number): EngineSample[] {
  const samples: EngineSample[] = [];
  for (const match of logText.matchAll(ENGINE_LINE)) {
    const [, month, day, hour, minute, second, promptTps, genTps, running] = match;
    // Logs carry month-day only; assume the current year, rolling back one if that lands in the future.
    let at = Date.UTC(
      new Date(now).getUTCFullYear(),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    if (at > now + 60_000) {
      at = Date.UTC(
        new Date(now).getUTCFullYear() - 1,
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      );
    }
    const active = Number(promptTps) > 0 || Number(genTps) > 0 || Number(running) > 0;
    samples.push({ at, active });
  }
  return samples.sort((a, b) => a.at - b.at);
}

// Idle = the current instance has been logging continuously for IDLE_MINUTES with nothing
// running in that span. Walking back from the newest sample and stopping at the first gap
// (a restart) ignores samples left over from before the last scale-to-zero, so a wake's
// cold start is never cancelled by stale idle logs.
function idleDurationMs(samples: EngineSample[], now: number): number | 'active' | 'not-logging' {
  const newest = samples[samples.length - 1];
  if (now - newest.at > FRESH_SAMPLE_MS) return 'not-logging';
  // Start of the current instance's continuous run of samples.
  let runStart = 0;
  for (let i = samples.length - 1; i > 0; i--) {
    if (samples[i].active) return 'active';
    if (samples[i].at - samples[i - 1].at > MAX_SAMPLE_GAP_MS) {
      runStart = i; // restart boundary: older samples belong to a previous instance
      break;
    }
  }
  if (runStart === 0 && samples[0].active) return 'active';
  return now - samples[runStart].at;
}

async function sleepIfIdle(): Promise<string> {
  const target = await findDeployment();
  if (!target || target.settings?.min_instances === 0) return 'already off';
  // Only a fully-loaded instance can be idle; downloading/deploying is the cold start, leave it.
  if (target.status !== 'running') return `status ${target.status}, kept running`;

  const now = Date.now();
  const from = Math.floor((now - (IDLE_MINUTES + 5) * 60_000) / 1000);
  const response = await fetch(
    `${API}/v1/deployment_logs/query?deploy_id=${target.deploy_id}&from=${from}&limit=1000`,
    { headers: authHeaders() }
  );
  if (!response.ok) throw new Error(`deployment_logs ${response.status}`);
  const samples = parseEngineSamples(await response.text(), now);
  if (samples.length === 0) return 'no engine samples, kept running';

  const idle = idleDurationMs(samples, now);
  if (idle === 'active') return 'active, kept running';
  if (idle === 'not-logging') return 'engine not logging, kept running';
  if (idle < IDLE_MINUTES * 60_000) return 'not idle long enough, kept running';
  await setInstances(target.deploy_id, 0);
  return 'idle, scaled to zero';
}

// Constant-time bearer check: /wake is on a public URL and each success bills GPUs. Comparing
// fixed-length SHA-256 digests keeps the comparison constant-time regardless of the inputs.
async function wakeTokenValid(header: string | null): Promise<boolean> {
  if (!header) return false;
  const encoder = new TextEncoder();
  const [got, want] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header)),
    crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${Resource.RedSnowWakeToken.value}`))
  ]);
  const a = new Uint8Array(got);
  const b = new Uint8Array(want);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/wake') {
      return new Response('not found', { status: 404 });
    }
    if (!(await wakeTokenValid(request.headers.get('authorization')))) {
      return new Response('unauthorized', { status: 401 });
    }
    return Response.json(await wake());
  },

  async scheduled(): Promise<void> {
    console.log(`red-snow idle check: ${await sleepIfIdle()}`);
  }
};
