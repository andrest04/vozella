import {
  ApiProviderError,
  CancelSource,
  isCancellation,
  readWavInfo,
  WAV_HEADER_BYTES,
  type SpeechToTextRequest,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, type FakeHttpReply } from '../fakes/fake-fetch';
import { DeepgramSpeechToTextClient } from './deepgram-speech-to-text-client';

const KEY = 'dg-test-secret-0123456789';
const RATE = 16_000;

const chunk = (seconds: number, language = 'es-US'): SpeechToTextRequest => ({
  samples: new Float32Array(Math.round(seconds * RATE)).fill(0.25),
  sampleRate: RATE,
  language,
  prompt: 'the text before',
});

const json = (body: unknown, extra: Partial<FakeHttpReply> = {}): FakeHttpReply => ({
  chunks: [JSON.stringify(body)],
  ...extra,
});

/** The shape observed from the real endpoint (see the feature document). */
const ANSWER = {
  metadata: { request_id: 'r', duration: 2.5, channels: 1 },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'Hola a todos.',
            confidence: 0.99,
            words: [
              { word: 'hola', start: 0.1, end: 0.42, confidence: 0.9, punctuated_word: 'Hola' },
              { word: 'a', start: 0.5, end: 0.6, confidence: 0.9, punctuated_word: 'a' },
              { word: 'todos', start: 0.7, end: 1.4, confidence: 0.9, punctuated_word: 'todos.' },
            ],
          },
        ],
      },
    ],
  },
};

function client(reply: FakeHttpReply, options: { key?: string | null; timeoutMs?: number } = {}) {
  const fake = new FakeFetch(reply);
  const key = options.key === undefined ? KEY : options.key;
  const made = new DeepgramSpeechToTextClient({
    displayName: 'Deepgram',
    baseUrl: 'https://api.example.test/v1',
    model: 'nova-3',
    apiKey: () => Promise.resolve(key),
    fetch: fake.fetch,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return { fake, made };
}

const none = (): CancelSource['signal'] => new CancelSource().signal;

const failure = (run: Promise<unknown>): Promise<ApiProviderError> =>
  run.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as ApiProviderError,
  );

describe('DeepgramSpeechToTextClient: the request', () => {
  it('posts the piece as a raw WAV to /listen with the Token scheme', async () => {
    const { fake, made } = client(json(ANSWER));
    await made.transcribe(chunk(2), none());
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({
      authorization: `Token ${KEY}`,
      'content-type': 'audio/wav',
    });
    const url = new URL(call?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.example.test/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'nova-3',
      punctuate: 'true',
      smart_format: 'true',
      language: 'es',
    });
    const wav = call?.bytes ?? new Uint8Array();
    expect(wav.length).toBe(WAV_HEADER_BYTES + 2 * RATE * 2);
    expect(
      readWavInfo({ length: wav.length, read: (o, n) => wav.subarray(o, o + n) }),
    ).toMatchObject({ sampleRate: RATE, channels: 1, bitsPerSample: 16, seconds: 2 });
  });

  it('asks for the multilingual model when the language is auto', async () => {
    const { fake, made } = client(json(ANSWER));
    await made.transcribe(chunk(1, 'auto'), none());
    expect(new URL(fake.calls[0]?.url ?? '').searchParams.get('language')).toBe('multi');
  });

  it('trims the key and reads it for every piece', async () => {
    const fake = new FakeFetch(json(ANSWER));
    let key = ` ${KEY} `;
    const made = new DeepgramSpeechToTextClient({
      displayName: 'Deepgram',
      baseUrl: 'https://api.example.test/v1',
      model: 'nova-3',
      apiKey: () => Promise.resolve(key),
      fetch: fake.fetch,
    });
    await made.transcribe(chunk(1), none());
    key = 'second-key';
    await made.transcribe(chunk(1), none());
    expect(fake.calls.map((call) => call.headers.authorization)).toEqual([
      `Token ${KEY}`,
      'Token second-key',
    ]);
  });

  it.each([null, '', '  '])(
    'fails as KeyMissing without a key (%j), sending nothing',
    async (key) => {
      const { fake, made } = client(json(ANSWER), { key });
      const error = await failure(made.transcribe(chunk(1), none()));
      expect(error).toMatchObject({ kind: 'KeyMissing', displayName: 'Deepgram' });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('sends nothing for a pass that is already cancelled', async () => {
    const { fake, made } = client(json(ANSWER));
    const cancel = new CancelSource();
    cancel.cancel();
    const error = await made.transcribe(chunk(1), cancel.signal).catch((thrown: unknown) => thrown);
    expect(isCancellation(error)).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('DeepgramSpeechToTextClient: the answer', () => {
  it('reads the transcript, the punctuated words and the measured duration', async () => {
    const { made } = client(json(ANSWER));
    expect(await made.transcribe(chunk(2), none())).toEqual({
      text: 'Hola a todos.',
      words: [
        { text: 'Hola', startMs: 100, endMs: 420 },
        { text: 'a', startMs: 500, endMs: 600 },
        { text: 'todos.', startMs: 700, endMs: 1400 },
      ],
      durationMs: 2500,
    });
  });

  it('answers silence as empty text with no words, and measures the piece itself', async () => {
    const silent = { results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] } };
    const { made } = client(json(silent));
    expect(await made.transcribe(chunk(2), none())).toEqual({
      text: '',
      words: [],
      durationMs: 2000,
    });
  });

  it('builds the text from the words when the transcript is missing', async () => {
    const answer = {
      results: {
        channels: [
          { alternatives: [{ words: ANSWER.results.channels[0]?.alternatives[0]?.words }] },
        ],
      },
    };
    const { made } = client(json(answer));
    expect((await made.transcribe(chunk(2), none())).text).toBe('Hola a todos.');
  });

  it.each([
    ['not an object', '[1,2]'],
    ['no results', '{"metadata":{}}'],
    ['no channels', '{"results":{"channels":[]}}'],
    ['no alternatives', '{"results":{"channels":[{"alternatives":[]}]}}'],
  ])('fails as Unknown for an answer with %s', async (_name, body) => {
    const { made } = client({ chunks: [body] });
    const error = await failure(made.transcribe(chunk(1), none()));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect(error.kind).toBe('Unknown');
  });
});

describe('DeepgramSpeechToTextClient: failures', () => {
  it.each([
    [401, '{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}', 'KeyInvalid'],
    [403, '{"err_code":"INSUFFICIENT_PERMISSIONS"}', 'KeyInvalid'],
    [402, '{"err_code":"ASR_PAYMENT_REQUIRED","err_msg":"no funds"}', 'QuotaExceeded'],
    [429, '{"err_code":"TOO_MANY_REQUESTS","err_msg":"slow down"}', 'RateLimited'],
    [400, '{"err_code":"Bad Request","err_msg":"bad audio"}', 'Unknown'],
    [500, 'oops', 'TimedOut'],
    [503, '', 'TimedOut'],
    [504, 'took too long', 'TimedOut'],
  ])('maps HTTP %i to %s', async (status, body, kind) => {
    const { made } = client({ status, chunks: [body] });
    const error = await failure(made.transcribe(chunk(1), none()));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect(error).toMatchObject({ kind, displayName: 'Deepgram' });
  });

  it('keeps the wait a rate limit asks for', async () => {
    const { made } = client({ status: 429, chunks: ['{}'], headers: { 'retry-after': '7' } });
    expect((await failure(made.transcribe(chunk(1), none()))).retryAfterMs).toBe(7000);
  });

  it('fails as Network when the host is unreachable', async () => {
    const { made } = client({ networkError: true });
    expect((await failure(made.transcribe(chunk(1), none()))).kind).toBe('Network');
  });

  it('fails as TimedOut when no byte arrives in time', async () => {
    const { made } = client({ hang: true }, { timeoutMs: 20 });
    expect((await failure(made.transcribe(chunk(1), none()))).kind).toBe('TimedOut');
  });

  it('never puts the key in an error', async () => {
    const { made } = client({ status: 400, chunks: [`the key ${KEY} is odd`] });
    const error = await failure(made.transcribe(chunk(1), none()));
    expect(error.kind).toBe('Unknown');
    expect(error.message).not.toContain(KEY);
    expect(error.detail ?? '').not.toContain(KEY);
  });

  it('ends as a cancellation when the pass is cancelled mid-request', async () => {
    const { made } = client({ hang: true });
    const cancel = new CancelSource();
    const pending = made.transcribe(chunk(1), cancel.signal).catch((thrown: unknown) => thrown);
    cancel.cancel();
    expect(isCancellation(await pending)).toBe(true);
  });
});
