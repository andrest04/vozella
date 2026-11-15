import {
  ApiProviderError,
  CancelSource,
  isCancellation,
  readSettings,
  readWavInfo,
  WAV_HEADER_BYTES,
  type SpeechToTextRequest,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { FakeApiKeyStore } from '../fakes/fake-api-key-store';
import { FakeFetch, type FakeHttpReply } from '../fakes/fake-fetch';
import {
  createCloudSpeechToTextClient,
  OpenAiSpeechToTextClient,
  SPEECH_PROMPT_MAX_CHARS,
} from './openai-speech-to-text-client';

const KEY = 'gsk-test-secret-0123456789';
const RATE = 16_000;

const chunk = (seconds: number, language = 'es', prompt?: string | null): SpeechToTextRequest => ({
  samples: new Float32Array(Math.round(seconds * RATE)).fill(0.25),
  sampleRate: RATE,
  language,
  ...(prompt === undefined ? {} : { prompt }),
});

const json = (body: unknown, extra: Partial<FakeHttpReply> = {}): FakeHttpReply => ({
  chunks: [JSON.stringify(body)],
  ...extra,
});

const VERBOSE = {
  text: ' Hola a todos.',
  language: 'spanish',
  duration: 2,
  segments: [{ start: 0, end: 1.5, text: ' Hola a todos.' }],
  words: [
    { word: 'Hola', start: 0.1, end: 0.42 },
    { word: 'a', start: 0.5, end: 0.6 },
    { word: 'todos.', start: 0.7, end: 1.4 },
  ],
};

function client(reply: FakeHttpReply, options: { key?: string | null; timeoutMs?: number } = {}) {
  const fake = new FakeFetch(reply);
  const key = options.key === undefined ? KEY : options.key;
  const made = new OpenAiSpeechToTextClient({
    displayName: 'Groq',
    baseUrl: 'https://api.example.test/v1',
    model: 'whisper-test',
    apiKey: () => Promise.resolve(key),
    fetch: fake.fetch,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return { fake, made };
}

const none = (): CancelSource['signal'] => new CancelSource().signal;

const failure = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error,
  );

const formOf = (fake: FakeFetch): FormData => {
  const form = fake.calls[0]?.form;
  if (!form) throw new Error('the request had no multipart body');
  return form;
};

describe('createCloudSpeechToTextClient: the request', () => {
  it.each([
    ['Groq', 'https://api.groq.com/openai/v1/audio/transcriptions', 'whisper-large-v3-turbo'],
    ['OpenAi', 'https://api.openai.com/v1/audio/transcriptions', 'whisper-1'],
  ] as const)('%s: posts the chunk as a WAV with word timestamps', async (kind, url, model) => {
    const fake = new FakeFetch(json(VERBOSE));
    const made = createCloudSpeechToTextClient(
      { keys: new FakeApiKeyStore({ [kind]: KEY }), fetch: fake.fetch },
      { kind, settings: readSettings({}) },
    );
    const result = await made.transcribe(chunk(2), none());

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe(url);
    expect(call?.method).toBe('POST');
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    // The multipart boundary is set by fetch: the adapter must not send a JSON content type.
    expect(call?.headers['content-type']).toBeUndefined();
    expect(call?.body).toBeNull();

    const form = formOf(fake);
    expect([...form.keys()]).toEqual([
      'file',
      'model',
      'response_format',
      'timestamp_granularities[]',
      'temperature',
      'language',
    ]);
    expect(form.get('model')).toBe(model);
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
    expect(form.get('temperature')).toBe('0');
    expect(form.get('language')).toBe('es');

    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    const upload = file as File;
    expect(upload.name).toBe('audio.wav');
    expect(upload.type).toBe('audio/wav');
    const bytes = new Uint8Array(await upload.arrayBuffer());
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 2 * RATE * 2);
    expect(readWavInfo({ length: bytes.length, read: (o, n) => bytes.subarray(o, o + n) })).toEqual(
      {
        sampleRate: RATE,
        channels: 1,
        bitsPerSample: 16,
        dataBytes: 2 * RATE * 2,
        seconds: 2,
      },
    );
    expect(new DataView(bytes.buffer).getInt16(WAV_HEADER_BYTES, true)).toBe(8192);

    expect(result).toEqual({
      text: 'Hola a todos.',
      durationMs: 2000,
      words: [
        { text: 'Hola', startMs: 100, endMs: 420 },
        { text: 'a', startMs: 500, endMs: 600 },
        { text: 'todos.', startMs: 700, endMs: 1400 },
      ],
    });
  });

  it('uses the model the caller saved instead of the default', async () => {
    const fake = new FakeFetch(json(VERBOSE));
    const made = createCloudSpeechToTextClient(
      { keys: new FakeApiKeyStore({ Groq: KEY }), fetch: fake.fetch },
      { kind: 'Groq', settings: readSettings({}), model: ' whisper-large-v3 ' },
    );
    await made.transcribe(chunk(1), none());
    expect(formOf(fake).get('model')).toBe('whisper-large-v3');
  });

  it('reads the key for every chunk, so a key saved later is used', async () => {
    const keys = new FakeApiKeyStore();
    const fake = new FakeFetch(json(VERBOSE));
    const made = createCloudSpeechToTextClient(
      { keys, fetch: fake.fetch },
      { kind: 'Groq', settings: readSettings({}) },
    );
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect((error as ApiProviderError).kind).toBe('KeyMissing');
    expect((error as ApiProviderError).displayName).toBe('Groq');
    expect(fake.calls).toHaveLength(0);

    await keys.set('Groq', KEY);
    await made.transcribe(chunk(1), none());
    expect(fake.calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    ['es-US', 'es'],
    ['es', 'es'],
    ['EN-us', 'en'],
    [' pt-BR ', 'pt'],
    ['zh_CN', 'zh'],
  ])('sends the language %j as the bare code %j', async (language, sent) => {
    const { fake, made } = client(json(VERBOSE));
    await made.transcribe(chunk(1, language), none());
    expect(formOf(fake).get('language')).toBe(sent);
  });

  it.each(['auto', 'AUTO', '', '  '])('omits the language for %j', async (language) => {
    const { fake, made } = client(json(VERBOSE));
    await made.transcribe(chunk(1, language), none());
    expect(formOf(fake).has('language')).toBe(false);
  });

  it('passes a short prompt trimmed, and no prompt when it is blank', async () => {
    const first = client(json(VERBOSE));
    await first.made.transcribe(chunk(1, 'es', '  el presupuesto del trimestre \n'), none());
    expect(formOf(first.fake).get('prompt')).toBe('el presupuesto del trimestre');

    for (const blank of [null, '', '   ']) {
      const { fake, made } = client(json(VERBOSE));
      await made.transcribe(chunk(1, 'es', blank), none());
      expect(formOf(fake).has('prompt')).toBe(false);
    }
  });

  it('keeps only the end of a long prompt, cut at a word', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${String(i)}`).join(' ');
    const { fake, made } = client(json(VERBOSE));
    await made.transcribe(chunk(1, 'es', long), none());
    const prompt = formOf(fake).get('prompt') as string;
    expect(prompt.length).toBeLessThanOrEqual(SPEECH_PROMPT_MAX_CHARS);
    expect(prompt.length).toBeGreaterThan(SPEECH_PROMPT_MAX_CHARS - 12);
    expect(long.endsWith(prompt)).toBe(true);
    expect(prompt.startsWith('word')).toBe(true);
    expect(long[long.length - prompt.length - 1]).toBe(' ');
  });

  it('refuses a chunk above the upload limit before any request', async () => {
    const fake = new FakeFetch(json(VERBOSE));
    const made = new OpenAiSpeechToTextClient({
      displayName: 'Groq',
      baseUrl: 'https://api.example.test/v1',
      model: 'whisper-test',
      apiKey: () => Promise.resolve(KEY),
      fetch: fake.fetch,
      maxFileBytes: WAV_HEADER_BYTES + 100,
    });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).kind).toBe('Unknown');
    expect((error as ApiProviderError).detail).toContain('too large');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('OpenAiSpeechToTextClient: the answer', () => {
  it('trims the words and drops the empty ones', async () => {
    const { made } = client(
      json({
        text: 'Hola, mundo.',
        duration: 1,
        words: [
          { word: ' Hola,', start: 0, end: 0.4 },
          { word: '', start: 0.4, end: 0.4 },
          { word: '   ', start: 0.4, end: 0.5 },
          { word: 'mundo. ', start: 0.5, end: 0.9 },
          { start: 0.9, end: 1 },
        ],
      }),
    );
    expect((await made.transcribe(chunk(1), none())).words).toEqual([
      { text: 'Hola,', startMs: 0, endMs: 400 },
      { text: 'mundo.', startMs: 500, endMs: 900 },
    ]);
  });

  it('never returns a negative time or a word that ends before it starts', async () => {
    const { made } = client(
      json({
        text: 'uno dos',
        duration: 1,
        words: [
          { word: 'uno', start: -0.2, end: 0.3004 },
          { word: 'dos', start: 0.6, end: 0.5 },
        ],
      }),
    );
    expect((await made.transcribe(chunk(1), none())).words).toEqual([
      { text: 'uno', startMs: 0, endMs: 300 },
      { text: 'dos', startMs: 600, endMs: 600 },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['not a list', 'none'],
  ])('with words %s, spreads the words of each segment evenly over it', async (_label, words) => {
    const { made } = client(
      json({
        text: ' Hola a todos. Gracias.',
        duration: 4,
        ...(words === undefined ? {} : { words }),
        segments: [
          { start: 0, end: 1.5, text: ' Hola a todos.' },
          { start: 1.5, end: 1.6, text: '  ' },
          { start: 2, end: 3, text: ' Gracias.' },
        ],
      }),
    );
    const result = await made.transcribe(chunk(4), none());
    expect(result.text).toBe('Hola a todos. Gracias.');
    expect(result.words).toEqual([
      { text: 'Hola', startMs: 0, endMs: 500 },
      { text: 'a', startMs: 500, endMs: 1000 },
      { text: 'todos.', startMs: 1000, endMs: 1500 },
      { text: 'Gracias.', startMs: 2000, endMs: 3000 },
    ]);
  });

  it('with neither words nor segments, spreads the text over the whole chunk', async () => {
    const { made } = client(json({ text: 'uno dos', duration: 2 }));
    expect((await made.transcribe(chunk(2), none())).words).toEqual([
      { text: 'uno', startMs: 0, endMs: 1000 },
      { text: 'dos', startMs: 1000, endMs: 2000 },
    ]);
  });

  it('builds the text from the words when the answer carries none', async () => {
    const { made } = client(json({ duration: 1, words: VERBOSE.words }));
    expect((await made.transcribe(chunk(1), none())).text).toBe('Hola a todos.');
  });

  it.each([
    ['an empty text', { text: '', duration: 2, words: [], segments: [] }],
    ['a blank text', { text: '  \n', duration: 2 }],
    ['an empty object', {}],
  ])('returns no text and no words for silence (%s)', async (_label, body) => {
    const { made } = client(json(body));
    expect(await made.transcribe(chunk(2), none())).toEqual({
      text: '',
      words: [],
      durationMs: 2000,
    });
  });

  it('measures the chunk itself when the answer has no duration', async () => {
    const { made } = client(json({ text: 'uno', words: [{ word: 'uno', start: 0, end: 0.2 }] }));
    expect((await made.transcribe(chunk(1.5), none())).durationMs).toBe(1500);
  });

  it.each([
    ['not JSON', 'upstream error page'],
    ['a JSON list', '[]'],
    ['a JSON string', '"ok"'],
  ])('fails as Unknown when the answer is %s', async (_label, body) => {
    const { made } = client({ chunks: [body] });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect((error as ApiProviderError).kind).toBe('Unknown');
  });
});

describe('OpenAiSpeechToTextClient: failures', () => {
  it.each([
    [401, '{"error":{"message":"Invalid API Key","type":"invalid_request_error"}}', 'KeyInvalid'],
    [404, '{"error":{"message":"The model `x` does not exist"}}', 'ModelNotFound'],
    [429, '{"error":{"message":"Rate limit reached","type":"tokens"}}', 'RateLimited'],
    [429, '{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}', 'QuotaExceeded'],
    [429, '{"error":{"code":"credit_balance_exhausted"}}', 'QuotaExceeded'],
    [413, '{"error":{"message":"Request Entity Too Large"}}', 'Unknown'],
    [500, 'boom', 'Unknown'],
  ] as const)('maps HTTP %i %j to %s', async (status, body, kind) => {
    const { made } = client({ status, chunks: [body] });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect((error as ApiProviderError).kind).toBe(kind);
    expect((error as ApiProviderError).displayName).toBe('Groq');
  });

  it('keeps the server text of a file that is too large (413)', async () => {
    const { made } = client({ status: 413, chunks: ['Request Entity Too Large'] });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).detail).toContain('Request Entity Too Large');
  });

  it('hands the retry-after of a rate limit to the caller', async () => {
    const { made } = client({
      status: 429,
      chunks: ['{"error":{"message":"Rate limit reached"}}'],
      headers: { 'retry-after': '7' },
    });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).kind).toBe('RateLimited');
    expect((error as ApiProviderError).retryAfterMs).toBe(7000);
  });

  it('gives no wait for a rate limit without the header', async () => {
    const { made } = client({ status: 429, chunks: ['slow down'] });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).retryAfterMs).toBeNull();
  });

  it.each(['insufficient_quota', 'credit_balance_exhausted'])(
    'never offers a retry for exhausted billing (%s)',
    async (code) => {
      const { made } = client({
        status: 429,
        chunks: [JSON.stringify({ error: { code } })],
        headers: { 'retry-after': '7' },
      });
      const error = await failure(() => made.transcribe(chunk(1), none()));
      expect((error as ApiProviderError).kind).toBe('QuotaExceeded');
      expect((error as ApiProviderError).retryAfterMs).toBeNull();
    },
  );

  it('keeps a 429 that only mentions a quota a rate limit, with its wait', async () => {
    // Groq words its audio-seconds limit as a quota; it lifts on its own, so it is retried.
    const { made } = client({
      status: 429,
      chunks: [
        JSON.stringify({
          error: {
            message: 'Rate limit reached: audio seconds per hour quota exceeded. Try again in 42s.',
            type: 'seconds',
            code: 'rate_limit_exceeded',
          },
        }),
      ],
      headers: { 'retry-after': '42' },
    });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).kind).toBe('RateLimited');
    expect((error as ApiProviderError).retryAfterMs).toBe(42_000);
  });

  it('never puts the key in the error message', async () => {
    const { made } = client({ status: 500, chunks: [`bad key ${KEY}`] });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as Error).message).not.toContain(KEY);
    expect(String((error as ApiProviderError).detail)).not.toContain(KEY);
  });

  it.each([null, '', '  '])('fails with KeyMissing before any request (key %j)', async (key) => {
    const { fake, made } = client(json(VERBOSE), { key });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).kind).toBe('KeyMissing');
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a failed connection to Network', async () => {
    const { made } = client({ networkError: true });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).kind).toBe('Network');
  });

  it('maps a request with no answer to TimedOut', async () => {
    const { made } = client({ hang: true }, { timeoutMs: 20 });
    const error = await failure(() => made.transcribe(chunk(1), none()));
    expect((error as ApiProviderError).kind).toBe('TimedOut');
  });

  it('rejects with a cancellation when cancelled while the request is open', async () => {
    const cancel = new CancelSource();
    const { fake, made } = client({ hang: true });
    const pending = failure(() => made.transcribe(chunk(1), cancel.signal));
    await expect.poll(() => fake.calls.length).toBe(1);
    cancel.cancel();
    const error = await pending;
    expect(isCancellation(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiProviderError);
  });

  it('rejects at once when already cancelled', async () => {
    const cancel = new CancelSource();
    cancel.cancel();
    const { fake, made } = client(json(VERBOSE));
    const error = await failure(() => made.transcribe(chunk(1), cancel.signal));
    expect(isCancellation(error)).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});
