import type { CancelSignal } from '../cancel';

/** One piece of a recording to transcribe: mono samples in -1..1, the form `AsrStream.push` takes. */
export interface SpeechToTextRequest {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** The meeting language as the app holds it: a code (`es`), an engine locale (`es-US`) or `auto`. */
  readonly language: string;
  /**
   * Text that came just before this piece, to keep spelling and names steady across pieces. The
   * client keeps as much of its end as its provider takes; null or blank sends none.
   */
  readonly prompt?: string | null;
}

/** A word and when it was said, in milliseconds from the start of the piece. */
export interface SpeechToTextWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SpeechToTextResult {
  /** Empty when nothing was said. */
  readonly text: string;
  /** In time order, never with empty text. Empty when nothing was said. */
  readonly words: readonly SpeechToTextWord[];
  /** The length of the piece as the provider measured it, else as the samples give it. */
  readonly durationMs: number;
}

/**
 * Port: a speech-to-text service that takes one piece of audio and answers its text with word
 * times. It knows nothing of chunking, offsets or streams: the cloud speech engine cuts the
 * recording, calls this once per piece and shifts the times. A provider plugs in by implementing
 * this alone. Failures leave as `ApiProviderError` (with `retryAfterMs` on a rate limit that says
 * how long to wait); a cancel as a cancellation.
 */
export interface SpeechToTextClient {
  transcribe(request: SpeechToTextRequest, cancel: CancelSignal): Promise<SpeechToTextResult>;
}
