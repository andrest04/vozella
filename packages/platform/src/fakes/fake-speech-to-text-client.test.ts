import { ApiProviderError, CancelSource, isCancellation } from '@vozella/core';
import { describe, expect, it } from 'vitest';
import {
  FAKE_SPEECH_WORD_MS,
  FakeSpeechToTextClient,
  fakeSpeechToTextOptionsFromEnv,
} from './fake-speech-to-text-client';

const RATE = 16_000;
const chunk = (seconds: number) => ({
  samples: new Float32Array(Math.round(seconds * RATE)),
  sampleRate: RATE,
  language: 'es',
});
const none = (): CancelSource['signal'] => new CancelSource().signal;

describe('FakeSpeechToTextClient', () => {
  it('hears one script word per half second of the chunk', async () => {
    const client = new FakeSpeechToTextClient({ phrases: ['uno dos tres', 'cuatro cinco'] });
    const result = await client.transcribe(chunk(2), none());
    expect(FAKE_SPEECH_WORD_MS).toBe(500);
    expect(result).toEqual({
      text: 'uno dos tres cuatro',
      durationMs: 2000,
      words: [
        { text: 'uno', startMs: 0, endMs: 400 },
        { text: 'dos', startMs: 500, endMs: 900 },
        { text: 'tres', startMs: 1000, endMs: 1400 },
        { text: 'cuatro', startMs: 1500, endMs: 1900 },
      ],
    });
  });

  it('answers as a provider does: punctuation and capitals in the text, bare words beside it', async () => {
    const client = new FakeSpeechToTextClient({
      phrases: ['Buenos días, a todos.', '¿Empezamos?'],
    });
    const result = await client.transcribe(chunk(2.5), none());
    expect(result.text).toBe('Buenos días, a todos. ¿Empezamos?');
    expect(result.words.map((word) => word.text)).toEqual([
      'buenos',
      'días',
      'a',
      'todos',
      'empezamos',
    ]);
    // The text is not the words joined: whoever rebuilds lines from the words must see that.
    expect(result.words.map((word) => word.text).join(' ')).not.toBe(result.text);
  });

  it('the default script has punctuation the word list does not', async () => {
    const result = await new FakeSpeechToTextClient().transcribe(chunk(4), none());
    expect(result.text).toBe('Buenos días a todos y gracias por venir.');
    expect(result.words.at(-1)?.text).toBe('venir');
    expect(result.words[0]?.text).toBe('buenos');
  });

  it('goes on with the script in the next chunk, with times from that chunk start', async () => {
    const client = new FakeSpeechToTextClient({ phrases: ['uno dos tres'] });
    await client.transcribe(chunk(1), none());
    const second = await client.transcribe(chunk(1), none());
    expect(second.words).toEqual([
      { text: 'tres', startMs: 0, endMs: 400 },
      { text: 'uno', startMs: 500, endMs: 900 },
    ]);
  });

  it('hears nothing in a chunk shorter than one word', async () => {
    const client = new FakeSpeechToTextClient();
    expect(await client.transcribe(chunk(0.3), none())).toEqual({
      text: '',
      words: [],
      durationMs: 300,
    });
  });

  it('gives the same answer for the same audio on a new client', async () => {
    const first = await new FakeSpeechToTextClient().transcribe(chunk(3), none());
    const second = await new FakeSpeechToTextClient().transcribe(chunk(3), none());
    expect(second).toEqual(first);
    expect(first.words).toHaveLength(6);
  });

  it('records every request', async () => {
    const client = new FakeSpeechToTextClient();
    const request = { ...chunk(1), prompt: 'before' };
    await client.transcribe(request, none());
    expect(client.requests).toEqual([request]);
  });

  it('fails with an API failure kind, or as Unknown with the text', async () => {
    const limited = new FakeSpeechToTextClient({ failWith: 'RateLimited', retryAfterMs: 3000 });
    const error = await limited.transcribe(chunk(1), none()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProviderError);
    expect((error as ApiProviderError).kind).toBe('RateLimited');
    expect((error as ApiProviderError).retryAfterMs).toBe(3000);
    expect(limited.requests).toHaveLength(1);

    const odd = new FakeSpeechToTextClient({ failWith: 'boom' });
    const unknown = await odd.transcribe(chunk(1), none()).catch((e: unknown) => e);
    expect((unknown as ApiProviderError).kind).toBe('Unknown');
    expect((unknown as ApiProviderError).detail).toBe('boom');
  });

  it('can fail only some chunks', async () => {
    const client = new FakeSpeechToTextClient({ failWith: 'Network', failChunks: [1] });
    await expect(client.transcribe(chunk(1), none())).resolves.toMatchObject({ durationMs: 1000 });
    await expect(client.transcribe(chunk(1), none())).rejects.toMatchObject({ kind: 'Network' });
    await expect(client.transcribe(chunk(1), none())).resolves.toMatchObject({ durationMs: 1000 });
  });

  it('waits for the delay and stops on cancel', async () => {
    const cancel = new CancelSource();
    const client = new FakeSpeechToTextClient({ delayMs: 5000 });
    const pending = client.transcribe(chunk(1), cancel.signal).catch((e: unknown) => e);
    cancel.cancel();
    expect(isCancellation(await pending)).toBe(true);
  });

  it('reads its options from the environment', () => {
    expect(fakeSpeechToTextOptionsFromEnv({})).toEqual({ delayMs: 0, failWith: null });
    expect(
      fakeSpeechToTextOptionsFromEnv({
        VOZELLA_FAKE_STT_DELAY_MS: '40',
        VOZELLA_FAKE_STT_FAIL: ' KeyInvalid ',
      }),
    ).toEqual({ delayMs: 40, failWith: 'KeyInvalid' });
    expect(fakeSpeechToTextOptionsFromEnv({ VOZELLA_FAKE_STT_DELAY_MS: 'x' }).delayMs).toBe(0);
  });
});
