const SPEECH_MODEL = '@cf/deepgram/nova-3';
const CORRECTIONS_KEY = 'corrections';
const MAX_KEYTERMS = 50;

interface Env {
  AI: Ai;
  CORRECTIONS: KVNamespace;
  AUTH_TOKEN: string;
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().replace(/\s+/g, ' ').toLowerCase();
}

function applyCorrections(raw: string, corrections: Record<string, string>): string {
  const phrases = Object.keys(corrections);
  if (!raw || phrases.length === 0) return raw;

  phrases.sort((left, right) => right.length - left.length);
  const alternation = phrases
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
    .join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, 'giu');

  return raw.replace(pattern, (matched) => corrections[normalizePhrase(matched)] ?? matched);
}

async function handleCorrections(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return Response.json({ error: 'corrections are required' }, { status: 400 });
  }

  const updates: Record<string, string> = {};
  for (const [rawHeard, rawCorrect] of entries) {
    if (typeof rawCorrect !== 'string') {
      return Response.json({ error: 'invalid correction' }, { status: 400 });
    }
    const heard = normalizePhrase(rawHeard);
    const correct = rawCorrect.trim();
    if (!heard || !correct) {
      return Response.json({ error: 'invalid correction' }, { status: 400 });
    }
    updates[heard] = correct;
  }

  const stored = (await env.CORRECTIONS.get<Record<string, string>>(CORRECTIONS_KEY, 'json')) ?? {};
  for (const [heard, correct] of Object.entries(updates)) {
    delete stored[heard];
    stored[heard] = correct;
  }

  await env.CORRECTIONS.put(CORRECTIONS_KEY, JSON.stringify(stored));
  return Response.json(updates);
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  if (!request.body || request.headers.get('content-length') === '0') {
    return Response.json({ error: 'missing audio body' }, { status: 400 });
  }

  const corrections =
    (await env.CORRECTIONS.get<Record<string, string>>(CORRECTIONS_KEY, 'json')) ?? {};
  const keyterms = [...new Set(Object.values(corrections).reverse())]
    .slice(0, MAX_KEYTERMS)
    .reverse();
  const keyterm = keyterms.length > 0 ? keyterms.join(', ') : undefined;

  let output: Ai_Cf_Deepgram_Nova_3_Output;
  try {
    output = await env.AI.run(SPEECH_MODEL, {
      audio: {
        body: request.body,
        contentType: request.headers.get('content-type') ?? ''
      },
      smart_format: true,
      ...(keyterm ? { keyterm } : {})
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('corrupt or unsupported data')) {
      return Response.json({ error: 'unsupported audio format' }, { status: 415 });
    }
    throw error;
  }

  const alternative = output.results?.channels?.[0]?.alternatives?.[0];
  const raw = alternative?.transcript ?? '';
  // NOTE: Workers AI Nova-3 omits a top-level duration field.
  const duration = alternative?.words?.at(-1)?.end ?? 0;
  const text = applyCorrections(raw, corrections);

  return Response.json({ text, raw, duration });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === 'GET' && pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (request.method !== 'POST' || (pathname !== '/transcribe' && pathname !== '/corrections')) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    const encoder = new TextEncoder();
    const provided = encoder.encode(request.headers.get('authorization') ?? '');
    const expected = encoder.encode(`Bearer ${env.AUTH_TOKEN}`);
    const authorized =
      provided.byteLength === expected.byteLength
        ? crypto.subtle.timingSafeEqual(provided, expected)
        : !crypto.subtle.timingSafeEqual(provided, provided);
    if (!authorized) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    if (pathname === '/corrections') return handleCorrections(request, env);
    return handleTranscribe(request, env);
  }
} satisfies ExportedHandler<Env>;
