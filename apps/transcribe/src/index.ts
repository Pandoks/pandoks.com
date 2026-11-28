const SPEECH_MODEL = '@cf/deepgram/nova-3';
const CORRECTION_KEY_PREFIX = 'c:';
// NOTE: Deepgram Nova-3 caps keyterms at 100 terms and 500 tokens; Cloudflare takes one string.
const MAX_KEYTERM_COUNT = 100;
const MAX_KEYTERM_TOKENS = 500;

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.qta': 'audio/quicktime',
  '.mov': 'audio/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
};

const CONTENT_TYPE_ALIASES: Record<string, string> = {
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4'
};

export interface Env {
  AI: Ai;
  CORRECTIONS: KVNamespace;
  AUTH_TOKEN: string;
}

interface Correction {
  heard: string;
  correct: string;
  count: number;
}

async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ]);
  if (!('type' in key)) return false;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(provided));
}

async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  const header = request.headers.get('authorization');
  if (!header) return false;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return false;
  return tokensMatch(match[1], expectedToken);
}

function normalizePhrase(phrase: string): string {
  return phrase.trim().replace(/\s+/g, ' ').toLowerCase();
}

function escapePhrase(phrase: string): string {
  return normalizePhrase(phrase)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+');
}

function estimateTokens(term: string): number {
  let tokens = 0;
  for (const word of term.split(/\s+/)) {
    if (word) tokens += Math.ceil(word.length / 4);
  }
  return tokens;
}

async function loadCorrections(store: KVNamespace): Promise<Correction[]> {
  const corrections: Correction[] = [];
  let cursor: string | undefined;
  let complete = false;

  while (!complete) {
    const page = await store.list<Correction>({ prefix: CORRECTION_KEY_PREFIX, cursor });
    for (const key of page.keys) {
      if (key.metadata) corrections.push(key.metadata);
    }
    complete = page.list_complete;
    cursor = page.list_complete ? undefined : page.cursor;
  }

  return corrections;
}

function buildKeyterms(corrections: Correction[]): string | undefined {
  const countsByTerm = new Map<string, number>();
  for (const correction of corrections) {
    countsByTerm.set(
      correction.correct,
      (countsByTerm.get(correction.correct) ?? 0) + correction.count
    );
  }

  const rankedTerms = [...countsByTerm.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  );

  const selected: string[] = [];
  let tokenCount = 0;
  for (const [term] of rankedTerms) {
    if (selected.length >= MAX_KEYTERM_COUNT) break;
    const termTokens = estimateTokens(term);
    if (tokenCount + termTokens > MAX_KEYTERM_TOKENS) continue;
    selected.push(term);
    tokenCount += termTokens;
  }

  return selected.length > 0 ? selected.join(' ') : undefined;
}

function applyCorrections(raw: string, corrections: Correction[]): string {
  if (!raw || corrections.length === 0) return raw;

  const sorted = [...corrections].sort(
    (left, right) => normalizePhrase(right.heard).length - normalizePhrase(left.heard).length
  );
  const replacements = new Map(
    sorted.map((correction) => [normalizePhrase(correction.heard), correction.correct])
  );
  const alternation = sorted.map((correction) => escapePhrase(correction.heard)).join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, 'giu');

  return raw.replace(pattern, (matched) => replacements.get(normalizePhrase(matched)) ?? matched);
}

function resolveContentType(file: File): string {
  const normalizedType = file.type.split(';')[0].trim().toLowerCase();
  if (normalizedType && normalizedType !== 'application/octet-stream') {
    return CONTENT_TYPE_ALIASES[normalizedType] ?? normalizedType;
  }

  const extensionMatch = /\.[^.]+$/.exec(file.name.toLowerCase());
  if (extensionMatch) {
    const mapped = EXTENSION_CONTENT_TYPES[extensionMatch[0]];
    if (mapped) return mapped;
  }

  return 'application/octet-stream';
}

function isUnsupportedAudioError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : '';
  if (/keyterm/i.test(message)) return false;

  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return (
    code === 8007 ||
    /\b8007\b|corrupt or unsupported|unsupported (?:audio|media|format|codec)/i.test(message)
  );
}

async function handleCorrection(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  if (typeof payload !== 'object' || payload === null) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const rawHeard = typeof record['heard'] === 'string' ? record['heard'] : '';
  const rawCorrect = typeof record['correct'] === 'string' ? record['correct'] : '';
  const heard = normalizePhrase(rawHeard);
  const correct = rawCorrect.trim();

  if (!heard || !correct) {
    return Response.json({ error: 'heard and correct are required' }, { status: 400 });
  }

  const key = `${CORRECTION_KEY_PREFIX}${heard}`;
  const existing = await env.CORRECTIONS.get<Correction>(key, 'json');
  const correction: Correction = {
    heard,
    correct,
    count: existing?.correct === correct ? existing.count + 1 : 1
  };

  await env.CORRECTIONS.put(key, JSON.stringify(correction), { metadata: correction });
  return Response.json(correction);
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: 'missing file' }, { status: 400 });
  }

  const corrections = await loadCorrections(env.CORRECTIONS);
  const keyterm = buildKeyterms(corrections);

  let output: Ai_Cf_Deepgram_Nova_3_Output;
  try {
    output = await env.AI.run(SPEECH_MODEL, {
      audio: {
        body: file.stream(),
        contentType: resolveContentType(file)
      },
      smart_format: true,
      ...(keyterm ? { keyterm } : {})
    });
  } catch (error) {
    if (isUnsupportedAudioError(error)) {
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

    if (!(await isAuthorized(request, env.AUTH_TOKEN))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    if (pathname === '/corrections') return handleCorrection(request, env);
    return handleTranscribe(request, env);
  }
} satisfies ExportedHandler<Env>;
