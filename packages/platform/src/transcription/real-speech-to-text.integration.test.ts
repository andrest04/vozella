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
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ApiProviderError,
  CancelSource,
  cloudTranscriptionApiEngine,
  resolveCloudTranscriptionModel,
  type CloudTranscriptionKind,
} from '@vozella/core';
import { OpenAiSpeechToTextClient } from './openai-speech-to-text-client';

const enabled = process.env.VOZELLA_REAL_STT === '1';
const wavPath = process.env.VOZELLA_REAL_STT_WAV ?? '';
const language = process.env.VOZELLA_REAL_STT_LANGUAGE ?? 'en-US';

const KEYS: Record<CloudTranscriptionKind, string> = {
  Groq: process.env.VOZELLA_REAL_STT_GROQ_KEY ?? '',
  OpenAi: process.env.VOZELLA_REAL_STT_OPENAI_KEY ?? '',
};
const KINDS = Object.keys(KEYS) as CloudTranscriptionKind[];

interface Pcm {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** Reads a mono PCM16 WAV whatever its header length, by walking the RIFF chunks. */
function readMonoPcm16(file: string): Pcm {
  const bytes = fs.readFileSync(file);
  let sampleRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      expect(bytes.readUInt16LE(body + 2), 'channels').toBe(1);
      expect(bytes.readUInt16LE(body + 14), 'bits per sample').toBe(16);
      sampleRate = bytes.readUInt32LE(body + 4);
    } else if (id === 'data') {
      const count = Math.floor(Math.min(size, bytes.length - body) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) samples[i] = bytes.readInt16LE(body + i * 2) / 32768;
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`No data chunk in ${file}`);
}

/** Half a second of a quiet tone: enough to be a valid upload for the rejected-key tests. */
function tone(): Pcm {
  const sampleRate = 16_000;
  const samples = new Float32Array(sampleRate / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return { samples, sampleRate };
}

function client(kind: CloudTranscriptionKind, key: string): OpenAiSpeechToTextClient {
  const engine = cloudTranscriptionApiEngine(kind);
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
    expect(String((failure as ApiProviderError).message)).not.toContain('vozella-not-a-real-key');
  });

  it.each(KINDS)('%s transcribes speech with timed words', async (kind) => {
    const key = KEYS[kind];
    if (key === '' || wavPath === '') return;
    const pcm = readMonoPcm16(wavPath);
    const audioMs = (pcm.samples.length / pcm.sampleRate) * 1000;

    const result = await client(kind, key).transcribe(
      { ...pcm, language },
      new CancelSource().signal,
    );

    // The facts the fakes cannot show: printed so a person can read them.
    console.log(
      JSON.stringify(
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
      ),
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
