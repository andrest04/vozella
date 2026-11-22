/**
 * Real-provider proof of the cloud speech-to-text client. It uploads one short WAV to the real
 * Groq and OpenAI endpoints and checks what comes back. It costs a few seconds of billed audio
 * on the account of each key given, and it sends that WAV to the provider.
 *
 *   VOZELLA_REAL_STT=1 pnpm --filter @vozella/platform exec vitest run real-speech-to-text
 *
 * - The rejected-key tests need nothing else: they prove the endpoint, the request shape up to
 *   authentication, and the failure mapping.
 * - The transcription tests also need `VOZELLA_REAL_STT_WAV` (a mono PCM16 WAV with speech) and
 *   `VOZELLA_REAL_STT_GROQ_KEY` and/or `VOZELLA_REAL_STT_OPENAI_KEY`. A provider without a key
 *   is skipped. `VOZELLA_REAL_STT_LANGUAGE` (default `en-US`) is the app language tag sent.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiProviderError,
  CancelSource,
  cloudTranscriptionProvider,
  resolveCloudTranscriptionModel,
} from '@vozella/core';
import { OpenAiSpeechToTextClient } from './openai-speech-to-text-client';
import {
  pcmMs,
  readMonoPcm16,
  realSttEnabled as enabled,
  realSttLanguage as language,
  realSttWavPath as wavPath,
  tone,
} from './real-stt-test-kit';

/** The kinds served by the OpenAI-compatible client; Deepgram has its own adapters and test. */
type OpenAiCompatibleKind = 'Groq' | 'OpenAi';

const KEYS: Record<OpenAiCompatibleKind, string> = {
  Groq: process.env.VOZELLA_REAL_STT_GROQ_KEY ?? '',
  OpenAi: process.env.VOZELLA_REAL_STT_OPENAI_KEY ?? '',
};
const KINDS = Object.keys(KEYS) as OpenAiCompatibleKind[];

function client(kind: OpenAiCompatibleKind, key: string): OpenAiSpeechToTextClient {
  const engine = cloudTranscriptionProvider(kind);
  return new OpenAiSpeechToTextClient({
    displayName: engine.displayName,
    baseUrl: engine.defaultBaseUrl ?? '',
    model: resolveCloudTranscriptionModel(kind, null),
    apiKey: () => Promise.resolve(key),
    timeoutMs: 60_000,
  });
}

describe.skipIf(!enabled)('the real speech-to-text endpoints', () => {
  it.each(KINDS)('%s rejects a key it does not know as KeyInvalid', async (kind) => {
    const failure = await client(kind, 'vozella-not-a-real-key')
      .transcribe({ ...tone(), language }, new CancelSource().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ApiProviderError);
    expect((failure as ApiProviderError).kind).toBe('KeyInvalid');
    expect((failure as ApiProviderError).message).not.toContain('vozella-not-a-real-key');
  });

  it.each(KINDS)('%s transcribes speech with timed words', async (kind) => {
    const key = KEYS[kind];
    if (key === '' || wavPath === '') return;
    const pcm = readMonoPcm16(wavPath);
    const audioMs = pcmMs(pcm);

    const result = await client(kind, key).transcribe(
      { ...pcm, language },
      new CancelSource().signal,
    );

    // The facts the fakes cannot show: printed so a person can read them.
    process.stdout.write(
      `${JSON.stringify(
        {
          kind,
          model: resolveCloudTranscriptionModel(kind, null),
          audioMs: Math.round(audioMs),
          durationMs: result.durationMs,
          text: result.text,
          wordCount: result.words.length,
          textTokenCount: result.text.split(/\s+/).filter(Boolean).length,
          words: result.words.slice(0, 12),
        },
        null,
        2,
      )}\n`,
    );

    expect(result.text.trim()).not.toBe('');
    expect(result.words.length).toBeGreaterThan(0);
    let previousStart = 0;
    for (const word of result.words) {
      expect(word.text).toBe(word.text.trim());
      expect(word.text).not.toBe('');
      expect(word.startMs).toBeGreaterThanOrEqual(previousStart);
      expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
      // A provider may round a little past the end of the audio.
      expect(word.endMs).toBeLessThanOrEqual(audioMs + 1500);
      previousStart = word.startMs;
    }
  });
});
