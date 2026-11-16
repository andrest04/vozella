import {
  API_FAILURE_KINDS,
  ApiProviderError,
  type CloudSpeechTimer,
  type SpeechToTextWord,
  type StreamingSpeechListener,
  type StreamingSpeechOptions,
  type StreamingSpeechProvider,
  type StreamingSpeechResult,
  type StreamingSpeechSession,
} from '@vozella/core';
import { fakeAsrPhrasesFromEnv } from './fake-asr-engine';

/** The fake hears one word of its script in every half second of audio. */
export const FAKE_STREAM_WORD_MS = 500;
const SPOKEN_MS = 400;

export interface FakeStreamingSpeechOptions {
  /** How long the session takes to open, and how far behind the audio each result arrives. */
  readonly delayMs?: number;
  /**
   * Refuses every session instead of opening it: an API failure kind (`KeyInvalid`), or any other
   * text for `Unknown`. Null opens normally.
   */
  readonly failWith?: string | null;
  /** The script; defaults to the one the fake speech engine reads. */
  readonly phrases?: readonly string[];
}

/** VOZELLA_FAKE_STREAM_DELAY_MS and VOZELLA_FAKE_STREAM_FAIL, for e2e. */
export function fakeStreamingSpeechOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { readonly delayMs: number; readonly failWith: string | null } {
  const delay = Number(env.VOZELLA_FAKE_STREAM_DELAY_MS);
  return {
    delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
    failWith: env.VOZELLA_FAKE_STREAM_FAIL?.trim() ? env.VOZELLA_FAKE_STREAM_FAIL.trim() : null,
  };
}

/** Real waits, for the fake native build when no timer is handed in. */
const realTimer: Pick<CloudSpeechTimer, 'wait'> = {
  wait: (ms, cancel) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancel.onCancel(() => {
        clearTimeout(timer);
        resolve();
      });
    }),
};

/**
 * A streaming speech provider that needs no key and no network. What it "hears" depends only on
 * how much audio it was sent: one word of the script per half second, as an interim result that
 * grows word by word and a final result when the phrase ends, so the live text visibly rewrites
 * itself. With no delay it opens and answers at once, inside the call; with one, on the timer.
 */
export class FakeStreamingSpeechProvider implements StreamingSpeechProvider {
  readonly displayName = 'Fake streaming speech';
  readonly sessions: FakeStreamingSpeechSession[] = [];

  constructor(
    private readonly options: FakeStreamingSpeechOptions = {},
    private readonly timer: Pick<CloudSpeechTimer, 'wait'> = realTimer,
  ) {}

  open(options: StreamingSpeechOptions, listener: StreamingSpeechListener): StreamingSpeechSession {
    const session = new FakeStreamingSpeechSession(this.options, this.timer, options, listener);
    this.sessions.push(session);
    session.start();
    return session;
  }
}

export class FakeStreamingSpeechSession implements StreamingSpeechSession {
  /** How much audio the session was sent. */
  receivedMs = 0;
  private readonly phrases: readonly (readonly string[])[];
  private done = false;
  private isOpen = false;
  /** Words heard so far, over the whole stream. */
  private heard = 0;
  private phrase = 0;
  /** The words of the phrase being said. */
  private current: SpeechToTextWord[] = [];

  constructor(
    private readonly options: FakeStreamingSpeechOptions,
    private readonly timer: Pick<CloudSpeechTimer, 'wait'>,
    private readonly stream: StreamingSpeechOptions,
    private readonly listener: StreamingSpeechListener,
  ) {
    this.phrases = (options.phrases ?? fakeAsrPhrasesFromEnv({}))
      .map((phrase) => phrase.split(' ').filter((word) => word !== ''))
      .filter((words) => words.length > 0);
    stream.cancel.onCancel(() => {
      this.done = true;
    });
  }

  /** Opens the session, or refuses it, after the delay. */
  start(): void {
    this.later(() => {
      const failure = this.options.failWith ?? null;
      if (failure === null) {
        this.isOpen = true;
        this.listener.opened();
        return;
      }
      const kind = API_FAILURE_KINDS.find((candidate) => candidate === failure) ?? 'Unknown';
      this.done = true;
      this.listener.closed(
        new ApiProviderError('Fake streaming speech', kind, kind === 'Unknown' ? failure : null),
      );
    });
  }

  send(samples: Float32Array): void {
    if (this.done || !this.isOpen) return;
    this.receivedMs += (samples.length * 1000) / this.stream.sampleRate;
    const words = this.phrases.length === 0 ? 0 : Math.floor(this.receivedMs / FAKE_STREAM_WORD_MS);
    while (this.heard < words) this.hear();
  }

  finish(): void {
    if (this.done || !this.isOpen) return;
    this.isOpen = false;
    // Like a real provider, the last final answers for all the audio it was sent, words or not:
    // the engine counts audio no final reaches as lost.
    const last = this.receivedMs === 0 ? null : { ...this.result(), processedMs: this.receivedMs };
    this.current = [];
    this.later(() => {
      if (last !== null) this.listener.final(last);
      this.done = true;
      this.listener.closed(null);
    });
  }

  close(): void {
    this.done = true;
  }

  /** One more word: the phrase so far as an interim result, or as a final when it is complete. */
  private hear(): void {
    const script = this.phrases[this.phrase % this.phrases.length] ?? [];
    const startMs = this.heard * FAKE_STREAM_WORD_MS;
    this.current.push({
      text: script[this.current.length] ?? '',
      startMs,
      endMs: startMs + SPOKEN_MS,
    });
    this.heard += 1;
    const result = this.result();
    const complete = this.current.length >= script.length;
    if (complete) {
      this.current = [];
      this.phrase += 1;
    }
    this.later(() => {
      if (complete) this.listener.final(result);
      else this.listener.interim(result);
    });
  }

  private result(): StreamingSpeechResult {
    const words = [...this.current];
    return {
      text: words.map((word) => word.text).join(' '),
      words,
      processedMs: this.heard * FAKE_STREAM_WORD_MS,
    };
  }

  /** Runs `step` now, or after the delay; never once the session is over. */
  private later(step: () => void): void {
    const delayMs = this.options.delayMs ?? 0;
    if (delayMs <= 0) {
      if (!this.done) step();
      return;
    }
    void this.timer.wait(delayMs, this.stream.cancel).then(() => {
      if (!this.done) step();
    });
  }
}
