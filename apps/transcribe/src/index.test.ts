import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index.ts';

const TEST_TOKEN = 'test-bearer-token-value';
const KV_PAGE_SIZE = 50;

interface StoredValue {
  value: string;
  metadata?: unknown;
}

function createMemoryKv(): KVNamespace {
  const entries = new Map<string, StoredValue>();

  const kv = {
    get(key: string, type?: string) {
      const entry = entries.get(key);
      if (!entry) return Promise.resolve(null);
      return Promise.resolve(type === 'json' ? (JSON.parse(entry.value) as unknown) : entry.value);
    },
    put(key: string, value: string, options?: { metadata?: unknown }) {
      entries.set(key, { value, metadata: options?.metadata });
      return Promise.resolve();
    },
    list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? '';
      const offset = options?.cursor ? Number(options.cursor) : 0;
      const matching = [...entries.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, entry]) => ({ name, metadata: entry.metadata }));
      const keys = matching.slice(offset, offset + KV_PAGE_SIZE);
      const nextOffset = offset + KV_PAGE_SIZE;
      if (nextOffset < matching.length) {
        return Promise.resolve({
          list_complete: false as const,
          keys,
          cursor: String(nextOffset),
          cacheStatus: null
        });
      }
      return Promise.resolve({ list_complete: true as const, keys, cacheStatus: null });
    }
  };

  return kv as unknown as KVNamespace;
}

interface RecordedAiCall {
  model: string;
  input: Ai_Cf_Deepgram_Nova_3_Input;
}

function createFakeAi(
  responder: (
    model: string,
    input: Ai_Cf_Deepgram_Nova_3_Input
  ) => Ai_Cf_Deepgram_Nova_3_Output | Promise<Ai_Cf_Deepgram_Nova_3_Output>
) {
  const calls: RecordedAiCall[] = [];
  const ai = {
    async run(model: string, input: Ai_Cf_Deepgram_Nova_3_Input) {
      calls.push({ model, input });
      return responder(model, input);
    }
  };
  return { ai: ai as unknown as Ai, calls };
}

function createEnv(
  responder: (
    model: string,
    input: Ai_Cf_Deepgram_Nova_3_Input
  ) => Ai_Cf_Deepgram_Nova_3_Output | Promise<Ai_Cf_Deepgram_Nova_3_Output> = () => ({
    results: {
      channels: [{ alternatives: [{ transcript: '', words: [] }] }]
    }
  })
) {
  const { ai, calls } = createFakeAi(responder);
  const env: Env = { AI: ai, CORRECTIONS: createMemoryKv(), AUTH_TOKEN: TEST_TOKEN };
  return { env, calls };
}

function send(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request, env);
}

function addCorrection(env: Env, heard: string, correct: string): Promise<Response> {
  return send(
    new Request('https://transcribe.example/corrections', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ heard, correct })
    }),
    env
  );
}

function transcribeFile(
  env: Env,
  file: File,
  token: string | null = TEST_TOKEN
): Promise<Response> {
  const formData = new FormData();
  formData.append('file', file);
  const headers = token === null ? undefined : { authorization: `Bearer ${token}` };
  return send(
    new Request('https://transcribe.example/transcribe', {
      method: 'POST',
      headers,
      body: formData
    }),
    env
  );
}

describe('routing and auth', () => {
  it('returns 200 on GET /health without auth', async () => {
    const { env } = createEnv();
    const response = await send(new Request('https://transcribe.example/health'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each([
    ['GET', '/unknown'],
    ['GET', '/transcribe'],
    ['GET', '/corrections'],
    ['POST', '/health']
  ])('returns 404 on %s %s', async (method, path) => {
    const { env } = createEnv();
    const response = await send(new Request(`https://transcribe.example${path}`, { method }), env);
    expect(response.status).toBe(404);
  });

  it.each(['/transcribe', '/corrections'])(
    'returns 401 on %s with missing or wrong token',
    async (path) => {
      const { env } = createEnv();

      for (const headers of [
        undefined,
        { authorization: 'Basic abc' },
        { authorization: 'Bearer wrong' },
        { authorization: `Bearer ${'x'.repeat(TEST_TOKEN.length)}` }
      ]) {
        const response = await send(
          new Request(`https://transcribe.example${path}`, { method: 'POST', headers }),
          env
        );
        expect(response.status).toBe(401);
      }
    }
  );

  it('returns 400 when /transcribe is missing a file or not multipart', async () => {
    const { env } = createEnv();

    const notMultipart = await send(
      new Request('https://transcribe.example/transcribe', {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        body: 'plain text'
      }),
      env
    );
    expect(notMultipart.status).toBe(400);

    const formData = new FormData();
    formData.append('other', 'value');
    const missingField = await send(
      new Request('https://transcribe.example/transcribe', {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        body: formData
      }),
      env
    );
    expect(missingField.status).toBe(400);
  });

  it('returns 400 when /corrections body is invalid', async () => {
    const { env } = createEnv();

    for (const body of ['not json', '{}', JSON.stringify({ heard: ' ', correct: 'Ghostty' })]) {
      const response = await send(
        new Request('https://transcribe.example/corrections', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            'content-type': 'application/json'
          },
          body
        }),
        env
      );
      expect(response.status).toBe(400);
    }
  });

  it('maps undecodable audio errors (code 8007) to 415', async () => {
    const { env } = createEnv(() => {
      throw new Error('AiError: 8007: corrupt or unsupported data');
    });

    const response = await transcribeFile(
      env,
      new File(['apac-bytes'], 'spatial.qta', { type: 'audio/quicktime' })
    );
    expect(response.status).toBe(415);
  });
});

describe('transcription and replacements', () => {
  it('returns raw untouched, applies case-insensitive whole-word/phrase replacements, and computes duration', async () => {
    const { env, calls } = createEnv(() => ({
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript:
                  'Pandocs opened Gosti and configured hammer spoon, ignoring agostic, gosti2, and sledgehammer spoon.',
                words: [
                  { word: 'Pandocs', start: 0.1, end: 0.5 },
                  { word: 'spoon', start: 4.1, end: 4.72 }
                ]
              }
            ]
          }
        ]
      }
    }));

    expect((await addCorrection(env, 'pandocs', 'Pandoks')).status).toBe(200);
    expect((await addCorrection(env, 'gosti', 'Ghostty')).status).toBe(200);
    expect((await addCorrection(env, 'hammer spoon', 'Hammerspoon')).status).toBe(200);

    const response = await transcribeFile(
      env,
      new File(['aac-audio'], 'memo.m4a', { type: 'application/octet-stream' })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      raw: 'Pandocs opened Gosti and configured hammer spoon, ignoring agostic, gosti2, and sledgehammer spoon.',
      text: 'Pandoks opened Ghostty and configured Hammerspoon, ignoring agostic, gosti2, and sledgehammer spoon.',
      duration: 4.72
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('@cf/deepgram/nova-3');
    expect(calls[0].input.audio.contentType).toBe('audio/mp4');
    expect(calls[0].input.audio.body).toBeInstanceOf(ReadableStream);
    expect(calls[0].input.smart_format).toBe(true);
  });

  it('prefers longer phrases, avoids cascading replacements, and handles regex/dollar characters literally', async () => {
    const { env } = createEnv(() => ({
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'Try foo bar, foo, c++, and path var in c++20.',
                words: []
              }
            ]
          }
        ]
      }
    }));

    await addCorrection(env, 'foo', 'bar');
    await addCorrection(env, 'foo bar', 'FooBar');
    await addCorrection(env, 'bar', 'WRONG');
    await addCorrection(env, 'c++', 'C++');
    await addCorrection(env, 'path var', '$PATH');

    const response = await transcribeFile(
      env,
      new File(['audio'], 'memo.qta', { type: 'application/octet-stream' })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      raw: 'Try foo bar, foo, c++, and path var in c++20.',
      text: 'Try FooBar, bar, C++, and $PATH in c++20.',
      duration: 0
    });
  });

  it('increments count for repeated pairs and resets when the correction target changes', async () => {
    const { env } = createEnv();

    expect(await (await addCorrection(env, 'gosti', 'Ghosty')).json()).toEqual({
      heard: 'gosti',
      correct: 'Ghosty',
      count: 1
    });
    expect(await (await addCorrection(env, 'Gosti', 'Ghosty')).json()).toEqual({
      heard: 'gosti',
      correct: 'Ghosty',
      count: 2
    });
    expect(await (await addCorrection(env, 'gosti', 'Ghostty')).json()).toEqual({
      heard: 'gosti',
      correct: 'Ghostty',
      count: 1
    });
  });
});

describe('keyterm ordering and caps', () => {
  it('omits keyterm when no corrections exist', async () => {
    const { env, calls } = createEnv();

    await transcribeFile(env, new File(['audio'], 'memo.qta', { type: '' }));

    expect(calls).toHaveLength(1);
    expect(calls[0].input.audio.contentType).toBe('audio/quicktime');
    expect(calls[0].input.keyterm).toBeUndefined();
  });

  it('deduplicates correct terms, orders most-used first, paginates KV, and caps at 100 terms', async () => {
    const { env, calls } = createEnv();

    for (let index = 1; index <= 105; index += 1) {
      await addCorrection(env, `heard${index}`, `Term${String(index).padStart(3, '0')}`);
    }
    await addCorrection(env, 'heard105', 'Term105');
    await addCorrection(env, 'heard105', 'Term105');
    await addCorrection(env, 'alias-for-104', 'Term104');

    await transcribeFile(env, new File(['audio'], 'memo.m4a', { type: 'audio/mp4' }));

    const keyterms = calls[0].input.keyterm!.split(' ');
    expect(keyterms).toHaveLength(100);
    expect(keyterms[0]).toBe('Term105');
    expect(keyterms[1]).toBe('Term104');
    expect(new Set(keyterms).size).toBe(100);
    expect(keyterms).not.toContain('Term103');
  });

  it('caps total keyterms within the 500-token budget for multi-word phrases', async () => {
    const { env, calls } = createEnv();

    for (let index = 1; index <= 70; index += 1) {
      const phrase = `LongDomainPhrase${index} ExtraWordOne ExtraWordTwo ExtraWordThree`;
      await addCorrection(env, `phrase ${index}`, phrase);
    }

    await transcribeFile(env, new File(['audio'], 'memo.m4a', { type: 'audio/mp4' }));

    const words = calls[0].input.keyterm!.split(' ');
    const estimatedTokens = words.reduce((sum, word) => sum + Math.ceil(word.length / 4), 0);
    expect(estimatedTokens).toBeLessThanOrEqual(500);
    expect(words.length).toBeLessThan(70 * 4);
  });
});
