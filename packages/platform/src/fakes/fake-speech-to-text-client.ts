import {
  API_FAILURE_KINDS,
  ApiProviderError,
  CancelledError,
  type CancelSignal,
  type SpeechToTextClient,
  type SpeechToTextRequest,
  type SpeechToTextResult,
  type SpeechToTextWord,
} from '@vozella/core';
import { fakeAsrPhrasesFromEnv } from './fake-asr-engine';

/** The fake hears one word of its script in every half second of audio. */
export const FAKE_SPEECH_WORD_MS = 500;
const SPOKEN_MS = 400;

export interface FakeSpeechToTextOptions {
  /** How long a call takes. Cancel is honored every few milliseconds. */
  readonly delayMs?: number;
  /** An API failure kind (`RateLimited`), any other text for `Unknown`, or null for success. */
  readonly failWith?: string | null;
  /** The wait a `RateLimited` failure carries. */
  readonly retryAfterMs?: number | null;
  /** Zero-based calls that fail; every call fails when this is not given. */
  readonly failChunks?: readonly number[];
  /** The script; defaults to the one the fake speech engine reads. */
  readonly phrases?: readonly string[];
}

/** VOZELLA_FAKE_STT_DELAY_MS and VOZELLA_FAKE_STT_FAIL, for e2e. */
export function fakeSpeechToTextOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): {
  readonly delayMs: number;
  readonly failWith: string | null;
} {
  const delay = Number(env.VOZELLA_FAKE_STT_DELAY_MS);
  return {
    delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
    failWith: env.VOZELLA_FAKE_STT_FAIL?.trim() ? env.VOZELLA_FAKE_STT_FAIL.trim() : null,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A script token as a provider's word list gives it: lower case, no punctuation around it. */
const bareWord = (token: string): string =>
  token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();

/**
 * A speech-to-text client that needs no key and no network. What it "hears" depends only on how
 * much audio it was given: one word of the script per half second of each piece, going on through
 * the script from one piece to the next, with times from the start of the piece.
 *
 * Like a real provider, the `text` keeps the punctuation and capitals of the script and the word
 * list does not, so a caller that builds lines from the words alone shows in the tests.
 */
export class FakeSpeechToTextClient implements SpeechToTextClient {
  readonly requests: SpeechToTextRequest[] = [];
  private readonly script: readonly string[];
  private spoken = 0;

  constructor(private readonly options: FakeSpeechToTextOptions = {}) {
    this.script = (options.phrases ?? fakeAsrPhrasesFromEnv({})).flatMap((phrase) =>
      phrase.split(' ').filter((word) => word !== ''),
    );
  }

  async transcribe(
    request: SpeechToTextRequest,
    cancel: CancelSignal,
  ): Promise<SpeechToTextResult> {
    const call = this.requests.length;
    this.requests.push(request);
    await this.wait(cancel);
    this.failIfAsked(call);

    const durationMs = Math.round((request.samples.length * 1000) / request.sampleRate);
    const count = this.script.length === 0 ? 0 : Math.floor(durationMs / FAKE_SPEECH_WORD_MS);
    const tokens: string[] = [];
    const words: SpeechToTextWord[] = [];
    for (let index = 0; index < count; index += 1) {
      const token = this.script[(this.spoken + index) % this.script.length] ?? '';
      const startMs = index * FAKE_SPEECH_WORD_MS;
      tokens.push(token);
      words.push({ text: bareWord(token), startMs, endMs: startMs + SPOKEN_MS });
    }
    this.spoken += count;
    return { text: tokens.join(' '), words, durationMs };
  }

  private async wait(cancel: CancelSignal): Promise<void> {
    const deadline = Date.now() + (this.options.delayMs ?? 0);
    while (Date.now() < deadline) {
      if (cancel.cancelled) throw new CancelledError();
      await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    if (cancel.cancelled) throw new CancelledError();
  }

  private failIfAsked(call: number): void {
    const failure = this.options.failWith ?? null;
    if (failure === null) return;
    if (this.options.failChunks && !this.options.failChunks.includes(call)) return;
    const kind = API_FAILURE_KINDS.find((candidate) => candidate === failure) ?? 'Unknown';
    throw new ApiProviderError(
      'Fake speech',
      kind,
      kind === 'Unknown' ? failure : null,
      undefined,
      kind === 'RateLimited' ? (this.options.retryAfterMs ?? null) : null,
    );
  }
}
