import { Resource } from 'sst';
import deployment from './deployment.json' with { type: 'json' };

// The model's full DeepInfra name is <github-username>/<model_name>.
const FULL_NAME = `Pandoks/${deployment.model_name}`;
const API = 'https://api.deepinfra.com';

const IDLE_MS = 30 * 60_000;
// Backstop: if activity pings never stop (e.g. a stuck client), scale down anyway. Longer than a
// burst day; a genuinely continuous >12h session would be cut and need a fresh SessionStart /wake.
const MAX_UPTIME_MS = 12 * 60 * 60_000;
// Don't reconcile (delete+recreate) a deployment younger than this. DeepInfra's created_at is
// strongly consistent, so this stops a concurrent /wake from deleting a deployment another just
// created while Workers KV's specHash is still propagating (KV reads can be stale ~60s).
const RECONCILE_MIN_AGE_MS = 20 * 60_000;

const KV = Resource.RedSnowScalerState;

// Activity writes are best-effort: Workers KV allows one write per key per second, so a SessionStart
// /wake and a near-simultaneous /ping can collide. A dropped write is harmless (the next ping
// refreshes it) and must never fail the request that performs it.
async function touchActivity(now: number) {
  try {
    await KV.put('lastActivity', String(now));
  } catch {
    // ignore KV rate-limit / transient write errors
  }
}

// Already gone: findDeployment skips these entirely (a `failed` one is still returned so wake can
// replace it). DEAD adds `failed` for the race fallback, which must never adopt a dead deployment.
const GONE_STATUSES = new Set(['deleted', 'deleting']);
const DEAD_STATUSES = new Set(['deleted', 'deleting', 'failed']);

interface Deployment {
  deploy_id: string;
  model_name: string;
  status: string;
  created_at?: string;
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
  return deployments.find((d) => d.model_name === FULL_NAME && !GONE_STATUSES.has(d.status));
}

async function setInstances(deployId: string, min: number) {
  const response = await fetch(`${API}/deploy/${deployId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ settings: { min_instances: min, max_instances: 1 } })
  });
  if (!response.ok) throw new Error(`PUT deploy/${deployId} ${response.status}`);
}

async function createDeployment(excludeDeployId?: string): Promise<Deployment> {
  const response = await fetch(`${API}/deploy/llm`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ...deployment, settings: { min_instances: 1, max_instances: 1 } })
  });
  if (!response.ok) {
    // A concurrent wake may have created a live one between the list and this POST; adopt that.
    // Never adopt the deployment we just deleted (a conflict from an async DELETE), or the reconcile
    // would record the new spec as applied without the change ever shipping.
    const raced = await findDeployment();
    if (raced && !DEAD_STATUSES.has(raced.status) && raced.deploy_id !== excludeDeployId) {
      return raced;
    }
    throw new Error(`deploy/llm ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Deployment;
}

async function deleteDeployment(deployId: string) {
  const response = await fetch(`${API}/deploy/${deployId}`, {
    method: 'DELETE',
    headers: authHeaders()
  });
  if (!response.ok) throw new Error(`DELETE deploy/${deployId} ${response.status}`);
}

// DeepInfra's DELETE can be asynchronous; wait until the id is gone so the follow-up create's POST
// doesn't conflict on the still-occupied model name.
async function waitUntilGone(deployId: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const response = await fetch(`${API}/deploy/list`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`deploy/list ${response.status}`);
    const deployments = (await response.json()) as Deployment[];
    if (!deployments.some((d) => d.deploy_id === deployId && d.status !== 'deleted')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`deploy ${deployId} still present after ${timeoutMs}ms`);
}

// Replace a deployment in place: delete, wait for it to clear, create fresh, record the new hash.
async function recreate(now: number, oldDeployId: string, hash: string): Promise<Deployment> {
  await deleteDeployment(oldDeployId);
  await waitUntilGone(oldDeployId);
  const created = await createDeployment(oldDeployId);
  await markRunning(now, hash);
  return created;
}

// Hash of the spec actually sent to DeepInfra, so a merged deployment.json change (including a
// Renovate revision bump) is detectable against what is running.
async function specHash(): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(deployment))
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function markRunning(now: number, hash: string) {
  await KV.put('specHash', hash);
  await KV.put('runningSince', String(now));
}

// Start the deployment and record activity. Create it on first use; if deployment.json changed
// since it was created, recreate it (only when idle, so an active session is never dropped);
// otherwise scale it up.
async function wake(): Promise<{ status: string; deploy_id: string; reconciled?: boolean }> {
  const now = Date.now();
  const previousActivity = Number(await KV.get('lastActivity')) || 0;
  await touchActivity(now);

  const desired = await specHash();
  const existing = await findDeployment();
  if (!existing) {
    const created = await createDeployment();
    await markRunning(now, desired);
    return { status: created.status, deploy_id: created.deploy_id };
  }

  // A failed deployment can't serve and blocks the name; replace it.
  if (existing.status === 'failed') {
    const created = await recreate(now, existing.deploy_id, desired);
    return { status: created.status, deploy_id: created.deploy_id, reconciled: true };
  }

  // A missing record (KV reset or a manually-created deployment) becomes a sentinel that differs
  // from every real hash, so the next idle wake reconciles it instead of silently serving a stale
  // spec. The first wake still only scales up (no destructive recreate mid-use).
  const appliedRaw = await KV.get('specHash');
  const applied = appliedRaw ?? 'unknown';
  // A scaled-to-zero deployment serves nothing, so it's always safe to reconcile even if a racing
  // /ping just refreshed lastActivity.
  const idle =
    existing.settings?.min_instances === 0 ||
    now - previousActivity > IDLE_MS ||
    existing.status !== 'running';
  // Age gate (DeepInfra's authoritative created_at) so a concurrent wake can't delete a deployment
  // another one just created while KV's specHash is still propagating.
  const oldEnough = now - Date.parse(existing.created_at ?? '') > RECONCILE_MIN_AGE_MS;
  if (applied !== desired && idle && oldEnough) {
    const created = await recreate(now, existing.deploy_id, desired);
    return { status: created.status, deploy_id: created.deploy_id, reconciled: true };
  }
  if (appliedRaw === null) await KV.put('specHash', 'unknown');
  if (existing.settings?.min_instances === 1) {
    // Already up: make sure the backstop has a start time (an adopted deployment may lack one).
    if (!(await KV.get('runningSince'))) await KV.put('runningSince', String(now));
  } else {
    await setInstances(existing.deploy_id, 1);
    await KV.put('runningSince', String(now));
  }
  return { status: existing.status, deploy_id: existing.deploy_id };
}

// Cron: scale to zero once activity has been quiet for IDLE_MS, with a hard uptime backstop.
async function sleepIfIdle(): Promise<string> {
  const target = await findDeployment();
  if (!target || target.settings?.min_instances === 0) return 'already off';
  if (target.status !== 'running') return `status ${target.status}, kept running`;

  const now = Date.now();
  const lastActivity = Number(await KV.get('lastActivity')) || 0;
  const runningSince = Number(await KV.get('runningSince')) || 0;

  if (now - lastActivity > IDLE_MS) {
    await setInstances(target.deploy_id, 0);
    return 'idle, scaled to zero';
  }
  if (runningSince && now - runningSince > MAX_UPTIME_MS) {
    await setInstances(target.deploy_id, 0);
    return 'max uptime reached, scaled to zero';
  }
  return 'active, kept running';
}

// Constant-time bearer check: the endpoints are public and each wake bills GPUs. Comparing
// fixed-length SHA-256 digests keeps the comparison constant-time regardless of the inputs.
async function tokenValid(header: string | null): Promise<boolean> {
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
  // POST /wake  -> SessionStart: create/reconcile/scale-up and record activity.
  // POST /ping  -> UserPromptSubmit: cheap heartbeat that just extends activity.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname;
    if (request.method !== 'POST' || (route !== '/wake' && route !== '/ping')) {
      return new Response('not found', { status: 404 });
    }
    if (!(await tokenValid(request.headers.get('authorization')))) {
      return new Response('unauthorized', { status: 401 });
    }
    if (route === '/ping') {
      await touchActivity(Date.now());
      return Response.json({ ok: true });
    }
    return Response.json(await wake());
  },

  async scheduled(): Promise<void> {
    console.log(`red-snow idle check: ${await sleepIfIdle()}`);
  }
};
