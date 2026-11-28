import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

const TEST_TOKEN = 'test-bearer-token-value';
const SAMPLE_AUDIO = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34]);

const AI_STUB_SOURCE = `
import { WorkerEntrypoint } from 'cloudflare:workers';

const EMPTY_OUTPUT = {
  results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] }
};

let nextOutput = EMPTY_OUTPUT;
let nextError = null;
const calls = [];

export default class AiStub extends WorkerEntrypoint {
  async run(model, input) {
    const reader = input.audio.body.getReader();
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      byteLength += value.byteLength;
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    calls.push({
      model,
      contentType: input.audio.contentType,
      byteLength,
      sha256,
      smartFormat: input.smart_format,
      hasKeyterm: 'keyterm' in input,
      keyterm: input.keyterm
    });

    if (nextError !== null) {
      throw new Error(nextError);
    }
    return nextOutput;
  }

  configure(options) {
    nextOutput = options.output ?? EMPTY_OUTPUT;
    nextError = options.error ?? null;
  }

  getCalls() {
    return calls;
  }

  reset() {
    calls.length = 0;
    nextOutput = EMPTY_OUTPUT;
    nextError = null;
  }
}
`;

interface RecordedAiCall {
  model: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  smartFormat: boolean;
  hasKeyterm: boolean;
  keyterm?: string;
}

interface AiStubRpc {
  configure(options: {
    output?: Ai_Cf_Deepgram_Nova_3_Output;
    error?: string | null;
  }): Promise<void>;
  getCalls(): Promise<RecordedAiCall[]>;
  reset(): Promise<void>;
}

let tempDirectory: string;
let server: TestHarness;
let baseUrl: URL;
let aiStub: AiStubRpc;
let correctionsStore: KVNamespace;

beforeAll(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'transcribe-test-'));
  const stubPath = join(tempDirectory, 'ai-stub.mjs');
  await writeFile(stubPath, AI_STUB_SOURCE);

  server = createTestHarness({
    root: resolve(import.meta.dirname, '..'),
    workers: [
      {
        config: {
          name: 'transcribe',
          main: 'src/index.ts',
          compatibility_date: '2026-11-04',
          kv_namespaces: [{ binding: 'CORRECTIONS', id: 'corrections' }],
          services: [{ binding: 'AI', service: 'ai-stub' }],
          vars: { AUTH_TOKEN: TEST_TOKEN }
        }
      },
      {
        config: {
          name: 'ai-stub',
          main: stubPath,
          compatibility_date: '2026-11-04'
        }
      }
    ]
  });

  ({ url: baseUrl } = await server.listen());
  aiStub = (await server.getWorker('ai-stub').getExport()) as unknown as AiStubRpc;
  const env = await server.getWorker<{ CORRECTIONS: KVNamespace }>('transcribe').getEnv();
  correctionsStore = env.CORRECTIONS;
}, 30_000);

beforeEach(async () => {
  await aiStub.reset();
  const { keys } = await correctionsStore.list();
  await Promise.all(keys.map((key) => correctionsStore.delete(key.name)));
});

afterAll(async () => {
  await server?.close();
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

function postCorrections(pairs: Record<string, unknown>, token: string | null = TEST_TOKEN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  return fetch(new URL('/corrections', baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(pairs)
  });
}

function postAudio(
  body: Uint8Array | null,
  contentType: string,
  token: string | null = TEST_TOKEN
) {
  const headers: Record<string, string> = {};
  if (contentType) headers['content-type'] = contentType;
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  return fetch(new URL('/transcribe', baseUrl), {
    method: 'POST',
    headers,
    ...(body !== null ? { body } : {})
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('routing and auth', () => {
  it('returns 200 on GET /health without auth', async () => {
    const response = await fetch(new URL('/health', baseUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each([
    ['GET', '/unknown'],
    ['GET', '/transcribe'],
    ['GET', '/corrections'],
    ['POST', '/health']
  ])('returns 404 on %s %s', async (method, path) => {
    const response = await fetch(new URL(path, baseUrl), { method });
    expect(response.status).toBe(404);
  });

  it.each(['/transcribe', '/corrections'])(
    'returns 401 on POST %s for missing, non-Bearer, wrong, and same-length wrong tokens',
    async (path) => {
      const body = path === '/corrections' ? JSON.stringify({ gosti: 'Ghostty' }) : SAMPLE_AUDIO;
      const contentType = path === '/corrections' ? 'application/json' : 'audio/mp4';

      for (const authorization of [
        undefined,
        'Basic abc',
        'Bearer wrong',
        `Bearer ${'x'.repeat(TEST_TOKEN.length)}`
      ]) {
        const headers: Record<string, string> = { 'content-type': contentType };
        if (authorization !== undefined) headers['authorization'] = authorization;

        const response = await fetch(new URL(path, baseUrl), {
          method: 'POST',
          headers,
          body
        });
        expect(response.status).toBe(401);
      }
    }
  );
});

describe('transcription', () => {
  it('forwards exact audio bytes and content type, returns raw and duration, and rejects empty body', async () => {
    await aiStub.configure({
      output: {
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: 'Hello world',
                  words: [
                    { word: 'Hello', start: 0.1, end: 0.5 },
                    { word: 'world', start: 0.6, end: 4.72 }
                  ]
                }
              ]
            }
          ]
        }
      }
    });

    const missingBody = await postAudio(null, 'audio/mp4');
    expect(missingBody.status).toBe(400);

    const emptyBody = await postAudio(new Uint8Array(0), 'audio/mp4');
    expect(emptyBody.status).toBe(400);
    expect(await aiStub.getCalls()).toHaveLength(0);

    const m4aResponse = await postAudio(SAMPLE_AUDIO, 'audio/mp4');
    expect(m4aResponse.status).toBe(200);
    expect(await m4aResponse.json()).toEqual({
      raw: 'Hello world',
      text: 'Hello world',
      duration: 4.72
    });

    const quicktimeBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const qtaResponse = await postAudio(quicktimeBytes, 'audio/quicktime');
    expect(qtaResponse.status).toBe(200);

    const calls = await aiStub.getCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      model: '@cf/deepgram/nova-3',
      contentType: 'audio/mp4',
      byteLength: SAMPLE_AUDIO.byteLength,
      sha256: sha256Hex(SAMPLE_AUDIO),
      smartFormat: true
    });
    expect(calls[1]).toMatchObject({
      model: '@cf/deepgram/nova-3',
      contentType: 'audio/quicktime',
      byteLength: quicktimeBytes.byteLength,
      sha256: sha256Hex(quicktimeBytes),
      smartFormat: true
    });
  });

  it('maps corrupt or unsupported data errors to 415 and does not map other model errors to 415', async () => {
    await aiStub.configure({ error: 'AiError: 8007: corrupt or unsupported data' });
    const unsupportedResponse = await postAudio(SAMPLE_AUDIO, 'audio/quicktime');
    expect(unsupportedResponse.status).toBe(415);

    await aiStub.configure({ error: 'AiError: 8007: keyterm limit exceeded' });
    const otherModelError = await postAudio(SAMPLE_AUDIO, 'audio/mp4');
    expect(otherModelError.status).not.toBe(415);
    expect(otherModelError.status).toBe(500);
  });
});

describe('corrections and replacements', () => {
  it('stores multiple pairs in one call, applies whole-word Unicode replacements, and updates existing pairs', async () => {
    const firstStore = await postCorrections({
      ' Pandocs ': ' Pandoks ',
      gosti: 'Ghostty',
      'hammer   spoon': 'Hammerspoon',
      café: 'Cafe'
    });
    expect(firstStore.status).toBe(200);
    expect(await firstStore.json()).toEqual({
      pandocs: 'Pandoks',
      gosti: 'Ghostty',
      'hammer spoon': 'Hammerspoon',
      café: 'Cafe'
    });

    await aiStub.configure({
      output: {
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript:
                    'Pandocs met at café with Gosti and hammer   spoon, ignoring agostic, gosti2, sledgehammer spoon, caféine, and décafé.',
                  words: [{ word: 'décafé', start: 0.1, end: 1.25 }]
                }
              ]
            }
          ]
        }
      }
    });

    const firstTranscribe = await postAudio(SAMPLE_AUDIO, 'audio/mp4');
    expect(firstTranscribe.status).toBe(200);
    expect(await firstTranscribe.json()).toEqual({
      raw: 'Pandocs met at café with Gosti and hammer   spoon, ignoring agostic, gosti2, sledgehammer spoon, caféine, and décafé.',
      text: 'Pandoks met at Cafe with Ghostty and Hammerspoon, ignoring agostic, gosti2, sledgehammer spoon, caféine, and décafé.',
      duration: 1.25
    });

    const updateStore = await postCorrections({ gosti: 'Ghostty App' });
    expect(updateStore.status).toBe(200);
    expect(await updateStore.json()).toEqual({ gosti: 'Ghostty App' });

    const secondTranscribe = await postAudio(SAMPLE_AUDIO, 'audio/mp4');
    expect(secondTranscribe.status).toBe(200);
    expect(await secondTranscribe.json()).toEqual({
      raw: 'Pandocs met at café with Gosti and hammer   spoon, ignoring agostic, gosti2, sledgehammer spoon, caféine, and décafé.',
      text: 'Pandoks met at Cafe with Ghostty App and Hammerspoon, ignoring agostic, gosti2, sledgehammer spoon, caféine, and décafé.',
      duration: 1.25
    });
  });

  it('prefers longest phrase, avoids cascading, and treats $ and regex characters literally', async () => {
    const storeResponse = await postCorrections({
      foo: 'bar',
      'foo bar': 'FooBar',
      bar: 'WRONG',
      'c++': 'C++',
      'path var': '$PATH',
      'dollar seq': '$& $1 $$'
    });
    expect(storeResponse.status).toBe(200);

    await aiStub.configure({
      output: {
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: 'Try foo bar, foo, c++, path var, and dollar seq in c++20.',
                  words: []
                }
              ]
            }
          ]
        }
      }
    });

    const response = await postAudio(SAMPLE_AUDIO, 'audio/quicktime');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      raw: 'Try foo bar, foo, c++, path var, and dollar seq in c++20.',
      text: 'Try FooBar, bar, C++, $PATH, and $& $1 $$ in c++20.',
      duration: 0
    });
  });

  it('returns 400 for invalid /corrections payloads', async () => {
    for (const body of [
      'not json',
      'null',
      '[]',
      '"text"',
      '123',
      '{}',
      JSON.stringify({ '': 'Ghostty' }),
      JSON.stringify({ '   ': 'Ghostty' }),
      JSON.stringify({ gosti: '' }),
      JSON.stringify({ gosti: '   ' }),
      JSON.stringify({ gosti: 42 }),
      JSON.stringify({ gosti: null }),
      JSON.stringify({ valid: 'Good', bad: '' })
    ]) {
      const response = await fetch(new URL('/corrections', baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json'
        },
        body
      });
      expect(response.status).toBe(400);
    }
  });
});

describe('key terms', () => {
  it('omits keyterm when there are no corrections', async () => {
    const response = await postAudio(SAMPLE_AUDIO, 'audio/mp4');
    expect(response.status).toBe(200);

    const [call] = await aiStub.getCalls();
    expect(call.hasKeyterm).toBe(false);
    expect(call.keyterm).toBeUndefined();
  });

  it('sends unique values comma-joined and keeps the 50 most recently added terms', async () => {
    await postCorrections({
      gosti: 'Ghostty',
      ghosty: 'Ghostty',
      'hammer spoon': 'Hammerspoon'
    });

    await postAudio(SAMPLE_AUDIO, 'audio/mp4');
    const [dedupedCall] = await aiStub.getCalls();
    expect(dedupedCall.keyterm).toBe('Ghostty, Hammerspoon');

    const batch: Record<string, string> = {};
    for (let index = 1; index <= 55; index += 1) {
      batch[`heard-${index}`] = `Term${String(index).padStart(2, '0')}`;
    }
    expect((await postCorrections(batch)).status).toBe(200);

    await postAudio(SAMPLE_AUDIO, 'audio/mp4');
    const calls = await aiStub.getCalls();
    const cappedTerms = calls[1].keyterm!.split(', ');
    expect(cappedTerms).toHaveLength(50);
    expect(new Set(cappedTerms).size).toBe(50);
    expect(cappedTerms[0]).toBe('Term06');
    expect(cappedTerms.at(-1)).toBe('Term55');
    expect(cappedTerms).not.toContain('Ghostty');
    expect(cappedTerms).not.toContain('Term05');
  });
});
