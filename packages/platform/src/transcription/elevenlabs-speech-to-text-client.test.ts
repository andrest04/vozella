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
import { ElevenLabsSpeechToTextClient } from './elevenlabs-speech-to-text-client';

const KEY = 'xi-test-secret-0123456789';
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

/** The documented single-channel answer of `POST /v1/speech-to-text`. */
const ANSWER = {
  language_code: 'spa',
  language_probability: 0.98,
  text: 'Hola a todos.',
  audio_duration_secs: 2.5,
  words: [
    { text: 'Hola', type: 'word', start: 0.1, end: 0.42, speaker_id: 'speaker_0', logprob: -0.1 },
    { text: ' ', type: 'spacing', start: 0.42, end: 0.5 },
    { text: 'a', type: 'word', start: 0.5, end: 0.6 },
    { text: ' ', type: 'spacing', start: 0.6, end: 0.7 },
    { text: 'todos.', type: 'word', start: 0.7, end: 1.4 },
  ],
};

function client(reply: FakeHttpReply, options: { key?: string | null; timeoutMs?: number } = {}) {
  const fake = new FakeFetch(reply);
  const key = options.key === undefined ? KEY : options.key;
  const made = new ElevenLabsSpeechToTextClient({
    displayName: 'ElevenLabs',
    baseUrl: 'https://api.example.test/v1',
    model: 'scribe_v3',
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

const fields = (form: FormData | null | undefined): Record<string, unknown> =>
  Object.fromEntries([...(form ?? new FormData()).entries()].filter(([name]) => name !== 'file'));

describe('ElevenLabsSpeechToTextClient: the request', () => {
  it('posts the piece as a multipart WAV to /speech-to-text with the xi-api-key header', async () => {
    const { fake, made } = client(json(ANSWER));
    await made.transcribe(chunk(2), none());
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('https://api.example.test/v1/speech-to-text');
    expect(call?.headers).toEqual({ 'xi-api-key': KEY });
    expect(fields(call?.form)).toEqual({
      model_id: 'scribe_v3',
      timestamps_granularity: 'word',
      diarize: 'false',
      tag_audio_events: 'false',
      language_code: 'es',
    });

    const file = call?.form?.get('file');
    expect(file).toBeInstanceOf(Blob);
    const blob = file as File;
    expect(blob.type).toBe('audio/wav');
    expect(blob.name).toBe('audio.wav');
    const wav = new Uint8Array(await blob.arrayBuffer());
    expect(wav.length).toBe(WAV_HEADER_BYTES + 2 * RATE * 2);
    expect(
      readWavInfo({ length: wav.length, read: (o, n) => wav.subarray(o, o + n) }),
    ).toMatchObject({ sampleRate: RATE, channels: 1, bitsPerSample: 16, seconds: 2 });
  });

  it('sends no language_code when the language is auto, so Scribe detects it', async () => {
    const { fake, made } = client(json(ANSWER));
    await made.transcribe(chunk(1, 'auto'), none());
    expect(fake.calls[0]?.form?.has('language_code')).toBe(false);
  });

  it('never sends the prompt: the endpoint has no field for the text before', async () => {
    const { fake, made } = client(json(ANSWER));
    await made.transcribe(chunk(1), none());
    const sent = [...(fake.calls[0]?.form?.values() ?? [])];
    expect(sent).not.toContain('the text before');
  });

  it('trims the key and reads it for every piece', async () => {
    const fake = new FakeFetch(json(ANSWER));
    let key = ` ${KEY} `;
    const made = new ElevenLabsSpeechToTextClient({
      displayName: 'ElevenLabs',
      baseUrl: 'https://api.example.test/v1',
      model: 'scribe_v2',
      apiKey: () => Promise.resolve(key),
      fetch: fake.fetch,
    });
    await made.transcribe(chunk(1), none());
    key = 'second-key';
    await made.transcribe(chunk(1), none());
    expect(fake.calls.map((call) => call.headers['xi-api-key'])).toEqual([KEY, 'second-key']);
    expect(fake.calls[0]?.form?.get('model_id')).toBe('scribe_v2');
  });

  it.each([null, '', '  '])(
    'fails as KeyMissing without a key (%j), sending nothing',
    async (key) => {
      const { fake, made } = client(json(ANSWER), { key });
      const error = await failure(made.transcribe(chunk(1), none()));
      expect(error).toMatchObject({ kind: 'KeyMissing', displayName: 'ElevenLabs' });
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

describe('ElevenLabsSpeechToTextClient: the answer', () => {
  it('reads the text, the spoken words and the measured duration', async () => {
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
    const { made } = client(json({ language_code: 'spa', text: '', words: [] }));
    expect(await made.transcribe(chunk(2), none())).toEqual({
      text: '',
      words: [],
      durationMs: 2000,
    });
  });

  it('builds the text from the words when the text is missing', async () => {
    const { made } = client(json({ words: ANSWER.words }));
    expect((await made.transcribe(chunk(2), none())).text).toBe('Hola a todos.');
  });

  it.each([
    ['not an object', '[1,2]'],
    ['neither text nor words', '{"language_code":"spa"}'],
    ['the webhook acknowledgement', '{"message":"ok","request_id":"r","transcription_id":"t"}'],
  ])('fails as Unknown for an answer with %s', async (_name, body) => {
    const { made } = client({ chunks: [body] });
    const error = await failure(made.transcribe(chunk(1), none()));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect(error.kind).toBe('Unknown');
  });
});

describe('ElevenLabsSpeechToTextClient: failures', () => {
  it.each([
    [401, '{"detail":{"type":"authentication_error","code":"invalid_api_key"}}', 'KeyInvalid'],
    [
      403,
      '{"detail":{"type":"authorization_error","code":"insufficient_permissions"}}',
      'KeyInvalid',
    ],
    [402, '{"detail":{"type":"payment_required","code":"insufficient_credits"}}', 'QuotaExceeded'],
    [429, '{"detail":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}', 'RateLimited'],
    [
      429,
      '{"detail":{"type":"rate_limit_error","code":"daily_generation_limit_reached"}}',
      'QuotaExceeded',
    ],
    [422, '{"detail":[{"loc":["body","file"],"msg":"bad","type":"value_error"}]}', 'Unknown'],
    [400, '{"detail":{"type":"validation_error","code":"invalid_audio"}}', 'Unknown'],
    [500, 'oops', 'TimedOut'],
    [503, '', 'TimedOut'],
  ])('maps HTTP %i to %s', async (status, body, kind) => {
    const { made } = client({ status, chunks: [body] });
    const error = await failure(made.transcribe(chunk(1), none()));
    expect(error).toBeInstanceOf(ApiProviderError);
    expect(error).toMatchObject({ kind, displayName: 'ElevenLabs' });
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
