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

// Start the deployment: create it on first use, otherwise scale it up from zero.
async function wake(): Promise<{ status: string; deploy_id: string }> {
  const existing = await findDeployment();
  if (!existing) {
    const response = await fetch(`${API}/deploy/llm`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...deployment, settings: { min_instances: 1, max_instances: 1 } })
    });
    if (!response.ok) throw new Error(`deploy/llm ${response.status}: ${await response.text()}`);
    const created = (await response.json()) as Deployment;
    return { status: created.status, deploy_id: created.deploy_id };
  }
  if (existing.settings?.min_instances !== 1) await setInstances(existing.deploy_id, 1);
  return { status: existing.status, deploy_id: existing.deploy_id };
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
  return samples;
}

// Idle = the engine has been logging for at least IDLE_MINUTES and nothing has run in that window.
// No samples means the deployment is still loading (no engine yet), so never sleep then.
async function sleepIfIdle(): Promise<string> {
  const target = await findDeployment();
  if (!target || target.settings?.min_instances === 0) return 'already off';

  const now = Date.now();
  const from = Math.floor((now - (IDLE_MINUTES + 5) * 60_000) / 1000);
  const response = await fetch(
    `${API}/v1/deployment_logs/query?deploy_id=${target.deploy_id}&from=${from}&limit=1000`,
    { headers: authHeaders() }
  );
  if (!response.ok) throw new Error(`deployment_logs ${response.status}`);
  const samples = parseEngineSamples(await response.text(), now);
  if (samples.length === 0) return 'loading, no engine samples';

  const windowStart = now - IDLE_MINUTES * 60_000;
  const activeRecently = samples.some((s) => s.at >= windowStart && s.active);
  const oldestAgeMin = (now - Math.min(...samples.map((s) => s.at))) / 60_000;
  if (!activeRecently && oldestAgeMin >= IDLE_MINUTES) {
    await setInstances(target.deploy_id, 0);
    return 'idle, scaled to zero';
  }
  return activeRecently ? 'active, kept running' : 'not idle long enough, kept running';
}

export default {
  // POST /wake with the shared bearer token starts the deployment.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/wake') {
      return new Response('not found', { status: 404 });
    }
    if (request.headers.get('authorization') !== `Bearer ${Resource.RedSnowWakeToken.value}`) {
      return new Response('unauthorized', { status: 401 });
    }
    return Response.json(await wake());
  },

  // Cron (every 5 min) scales the deployment to zero once it has been idle.
  async scheduled(): Promise<void> {
    console.log(`red-snow idle check: ${await sleepIfIdle()}`);
  }
};
