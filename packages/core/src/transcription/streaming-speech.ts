import type { CancelSignal } from '../cancel';
import type { ApiProviderError } from '../summaries/api-failure';
import type { SpeechToTextWord } from './speech-to-text';

/**
 * One result of a streaming session. Times are milliseconds from the first sample the session was
 * sent, so they need no shifting between results.
 */
export interface StreamingSpeechResult {
  /** The text of the result as the provider punctuates it. Blank when it gives words only. */
  readonly text: string;
  /** In time order, each with its punctuated text. Empty when nothing was said. */
  readonly words: readonly SpeechToTextWord[];
  /** How far into the audio it was sent the provider has listened when it gave this result. */
  readonly processedMs: number;
}

/**
 * What a session tells its caller. `opened` comes at most once and first; results come only after
 * it; `closed` comes exactly once and last, unless the caller closed the session itself.
 */
export interface StreamingSpeechListener {
  /** The session takes audio from now on. */
  opened(): void;
  /** Text that may still change: it replaces the interim result before it. */
  interim(result: StreamingSpeechResult): void;
  /** Text that will not change. The results after it are about later audio. */
  final(result: StreamingSpeechResult): void;
  /**
   * The session is over. Null only after `finish`, when the provider has answered for every sample
   * it was sent; otherwise the failure, and what was sent after the last final result is lost.
   */
  closed(error: ApiProviderError | null): void;
}

export interface StreamingSpeechOptions {
  /** The meeting language as the app holds it: a code (`es`), an engine locale (`es-US`) or `auto`. */
  readonly language: string;
  /** The rate of every sample the session will be sent. */
  readonly sampleRate: number;
  /** Ends the session at once, like `close`: nothing is told to the listener after it fires. */
  readonly cancel: CancelSignal;
}

/** One open conversation with a streaming provider. No method throws or waits. */
export interface StreamingSpeechSession {
  /** Mono samples in -1..1, in order. Called only after `opened`. */
  send(samples: Float32Array): void;
  /** No more audio: the provider gives its last final results and then `closed(null)`. */
  finish(): void;
  /** Abandons the session now. The listener hears nothing more. */
  close(): void;
}

/**
 * Port: a speech-to-text service that listens while the audio is still arriving and answers word
 * by word. It speaks of sessions, audio and results only, never of sockets or of one provider's
 * message names, so a provider plugs in by implementing this alone (adapters: platform). The
 * streaming speech engine does the rest: buffering until the session opens, turning results into
 * `AsrResult`s, counting lost audio, draining at Stop.
 */
export interface StreamingSpeechProvider {
  /** The provider name in the failures the engine itself reports (a session that never opens). */
  readonly displayName: string;
  /**
   * Starts a session and returns at once; `listener.opened` says when it takes audio. A session
   * that cannot start says so with `listener.closed(error)`, never by throwing.
   */
  open(options: StreamingSpeechOptions, listener: StreamingSpeechListener): StreamingSpeechSession;
}
