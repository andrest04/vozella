import { CancelSource, type CancelSignal } from '../cancel';
import { isApiProviderError, type ApiFailureKind } from '../summaries/api-failure';
import type {
  AsrEngine,
  AsrLatencyProfile,
  AsrRecognizer,
  AsrResult,
  AsrStream,
  AsrStreamCoverage,
  RecognizerSettings,
  StreamOptions,
} from './asr-types';
import { TranscriptionCancelledError } from './ports';
import type { SpeechToTextClient, SpeechToTextResult } from './speech-to-text';

/**
 * Live pieces are about this long, so the text arrives one piece behind the speaker. Shorter
 * pieces would cost more requests and give the model less context; longer ones would feel late.
 */
export const CLOUD_LIVE_CHUNK_TARGET_MS = 15_000;

/**
 * Offline pieces are up to about a minute: an hour of audio is about 60 requests, which stays
 * under Groq's 20 requests per minute once {@link CLOUD_MIN_REQUEST_INTERVAL_MS} spaces them, and
 * a minute of 16 kHz mono PCM16 is under 2 MB of the 25 MB an upload may be.
 */
export const CLOUD_OFFLINE_CHUNK_TARGET_MS = 60_000;

/**
 * No piece is cut shorter than this, except the tail of the audio: Groq bills every request as at
 * least 10 seconds, so shorter pieces pay for audio that was not sent.
 */
export const CLOUD_CHUNK_MIN_MS = 10_000;

/**
 * How far back from the target a cut may move to land on the quietest point, so a word is not
 * split between two pieces. The live target minus this stays above {@link CLOUD_CHUNK_MIN_MS}.
 */
export const CLOUD_QUIET_SEARCH_MS = 4_000;

/** The loudness is compared in frames of this length; a pause between words is longer. */
export const CLOUD_QUIET_FRAME_MS = 50;

/**
 * A request starts no sooner than this after the one before it: Groq's developer plan takes 20
 * requests per minute, one every 3 seconds. Live pieces arrive slower than that on their own; the
 * offline pass and a live pass that fell behind would not.
 */
export const CLOUD_MIN_REQUEST_INTERVAL_MS = 3_000;

/**
 * The longest wait a rate limit may ask an offline pass for and still be waited out: one hour, the
 * longest window a provider counts a limit over (Groq's audio seconds per hour). Failing sooner
 * would throw away a long file that only had to wait, and the pass can be cancelled meanwhile. A
 * longer wait is not a limit that lifts on its own, so the pass fails with the rate limit. A live
 * pass has no such bound: it holds its requests for as long as it is asked, since the buffer is
 * bounded and Stop ends the hold.
 */
export const CLOUD_RATE_LIMIT_MAX_WAIT_MS = 60 * 60_000;

/** The wait after a rate limit that names none. */
export const CLOUD_RATE_LIMIT_DEFAULT_WAIT_MS = 5_000;

/** How many times one piece is sent again because of a rate limit before it fails. */
export const CLOUD_RATE_LIMIT_MAX_RETRIES = 4;

/** How many times one piece is sent again after a network failure or a timeout. */
export const CLOUD_TRANSIENT_MAX_RETRIES = 2;

/** The wait before the first of those retries; it doubles for the next one. */
export const CLOUD_TRANSIENT_BACKOFF_MS = 3_000;

/**
 * Live audio waiting to be uploaded is kept up to this long. Buffering is cheap (five minutes of
 * 16 kHz mono float is about 19 MB), so uploads slower than real time lose nothing; past this the
 * oldest audio is dropped and counted as a gap instead of growing without bound.
 */
export const CLOUD_LIVE_MAX_BUFFERED_MS = 5 * 60_000;

/**
 * The most of the previous text handed to the client as the prompt of the next piece. The client
 * may keep less; the engine never hands over a whole transcript.
 */
export const CLOUD_PROMPT_MAX_CHARS = 400;

/**
 * A final tail shorter than this is not sent: providers refuse audio of under about a tenth of a
 * second (HTTP 400), which would fail an offline pass or leave a gap for a few samples that hold
 * no word. It counts as covered silence.
 */
export const CLOUD_MIN_UPLOAD_MS = 100;

/**
 * A piece whose every {@link CLOUD_QUIET_FRAME_MS} frame is quieter than this (RMS, full scale 1)
 * is not uploaded: about -60 dBFS, the level of a muted source, far under quiet speech. Whisper
 * style models asked to transcribe silence tend to repeat the prompt, and that text would be kept;
 * nor is silence worth paying for. It counts as covered audio with no text.
 */
export const CLOUD_SILENCE_RMS = 0.001;

/** Failures that waiting cannot fix. They are never retried, and they end a live pass. */
const FATAL_KINDS: readonly ApiFailureKind[] = [
  'KeyMissing',
  'KeyInvalid',
  'QuotaExceeded',
  'ModelNotFound',
];

/**
 * True for a failure that ends a live pass: the key, the account or the model is wrong, so every
 * later request would fail the same way. The user has to act; a gap in the text is not that.
 */
export const isFatalSpeechFailure = (error: unknown): boolean =>
  isApiProviderError(error) && FATAL_KINDS.includes(error.kind);

/** The clock and the waits of the engine, so tests need no real time. Adapter: platform. */
export interface CloudSpeechTimer {
  nowMs(): number;
  /** Resolves after `ms`, or as soon as `cancel` fires. */
  wait(ms: number, cancel: CancelSignal): Promise<void>;
}

/**
 * Spaces the requests of every pass that shares it by {@link CLOUD_MIN_REQUEST_INTERVAL_MS}. The
 * provider counts requests per key, not per pass, so a live pass and the pass after it (or one
 * running beside it) take their turns from the same pacer.
 */
export class CloudRequestPacer {
  private nextAtMs = Number.NEGATIVE_INFINITY;

  /**
   * Takes the next free slot and returns how long from `nowMs` it starts. The slot is taken at
   * once, so two passes asking at the same moment get different ones.
   */
  take(nowMs: number): number {
    const at = Math.max(nowMs, this.nextAtMs);
    this.nextAtMs = at + CLOUD_MIN_REQUEST_INTERVAL_MS;
    return at - nowMs;
  }
}

export interface CloudSpeechEngineDeps {
  readonly client: SpeechToTextClient;
  readonly timer: CloudSpeechTimer;
  /**
   * A live pass lost audio: the failure (null for a full buffer, the cancellation for a stream
   * closed before it finished) and how much. For the log.
   */
  readonly onLost?: (error: unknown, lostMs: number) => void;
  /** Shared by the passes of one provider; without it each stream paces only itself. */
  readonly pacer?: CloudRequestPacer;
}

/**
 * The cloud speech engine behind the `AsrEngine` port. It knows no provider and no HTTP: it cuts
 * the pushed audio into pieces, hands each to a `SpeechToTextClient` in order with one request in
 * flight, and turns the answers into `AsrResult`s with times from the start of the stream. Any
 * client plugs in.
 *
 * The latency profile picks the policy. `live`: `push` never waits, pieces are about 15 s, a
 * failed piece is a gap and the pass goes on. `offline`: `push` waits while a whole piece is
 * buffered (so a file is not read into memory ahead of the uploads), pieces are about a minute,
 * and a failed piece fails the pass.
 */
export class CloudSpeechEngine implements AsrEngine {
  constructor(private readonly deps: CloudSpeechEngineDeps) {}

  /** `cancel` aborts the request in flight and ends the stream as cancelled. */
  createRecognizer(
    settings: Pick<RecognizerSettings, 'latency'>,
    cancel?: CancelSignal,
  ): Promise<AsrRecognizer> {
    const { deps } = this;
    return Promise.resolve({
      startStream: (options: StreamOptions): Promise<AsrStream> =>
        Promise.resolve(new CloudSpeechStream(deps, settings.latency, options.language, cancel)),
      dispose: () => Promise.resolve(),
    });
  }
}

/**
 * Where to cut a window so the cut falls in its quietest frame of the last `searchMs`: the middle
 * of that frame. Audio that is no quieter anywhere than at its end is cut at the end. Returns a
 * sample count, never past the window.
 */
export function quietCutSamples(
  window: Float32Array,
  sampleRate: number,
  searchMs: number = CLOUD_QUIET_SEARCH_MS,
  frameMs: number = CLOUD_QUIET_FRAME_MS,
): number {
  const frame = Math.max(1, Math.round((frameMs * sampleRate) / 1000));
  const search = Math.min(window.length, Math.round((searchMs * sampleRate) / 1000));
  let best = window.length;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let end = window.length; end - frame >= window.length - search; end -= frame) {
    const energy = frameEnergy(window, end - frame, end);
    // Strictly quieter only: walking back from the end, a tie keeps the later cut.
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = end === window.length ? end : end - Math.floor(frame / 2);
    }
  }
  return best;
}

/** The loudness of `samples[from, to)` as the sum of its squares. */
function frameEnergy(samples: Float32Array, from: number, to: number): number {
  let energy = 0;
  for (let i = from; i < to; i += 1) energy += (samples[i] ?? 0) ** 2;
  return energy;
}

/**
 * True when no frame of the audio reaches {@link CLOUD_SILENCE_RMS}: there is nothing in it to
 * transcribe. One frame at or above the threshold makes the whole piece worth sending.
 */
export function isSilentAudio(
  samples: Float32Array,
  sampleRate: number,
  frameMs: number = CLOUD_QUIET_FRAME_MS,
): boolean {
  const frame = Math.max(1, Math.round((frameMs * sampleRate) / 1000));
  const limit = CLOUD_SILENCE_RMS ** 2;
  for (let from = 0; from < samples.length; from += frame) {
    const to = Math.min(samples.length, from + frame);
    // Mean square against the squared threshold: the same comparison as RMS, without the root.
    if (frameEnergy(samples, from, to) / (to - from) >= limit) return false;
  }
  return true;
}

/** The end of `text`, at most `maxChars` long, starting at a whole word. */
function promptTail(text: string, maxChars: number): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.length <= maxChars) return trimmed;
  const cutAt = trimmed.length - maxChars;
  const tail = trimmed.slice(cutAt);
  const midWord = /\S/.test(trimmed.charAt(cutAt - 1)) && /^\S/.test(tail);
  const whole = (midWord ? tail.replace(/^\S+/, '') : tail).trimStart();
  return whole === '' ? tail : whole;
}

interface Piece {
  readonly samples: Float32Array;
  /** Position of the first sample in the stream. */
  readonly startSample: number;
}

class CloudSpeechStream implements AsrStream {
  private readonly live: boolean;
  private readonly targetMs: number;
  private readonly cancel = new CancelSource();
  private readonly unlink: (() => void) | undefined;
  private sampleRate = 0;
  /** Audio not yet sent, oldest first. */
  private readonly pending: Float32Array[] = [];
  private pendingSamples = 0;
  /** Position in the stream of the first pending sample. */
  private headSample = 0;
  private lostSamples = 0;
  private readonly results: AsrResult[] = [];
  private pump: Promise<void> | null = null;
  /** Offline: what failed the pass. Thrown by `push` and `drain` from then on. */
  private failure: Error | null = null;
  /** Live: a failure waiting cannot fix ended the uploads; later audio is lost. */
  private stopped = false;
  private previousText = '';
  private readonly pacer: CloudRequestPacer;

  constructor(
    private readonly deps: CloudSpeechEngineDeps,
    latency: AsrLatencyProfile,
    private readonly language: string,
    cancel: CancelSignal | undefined,
  ) {
    this.live = latency === 'live';
    this.targetMs = this.live ? CLOUD_LIVE_CHUNK_TARGET_MS : CLOUD_OFFLINE_CHUNK_TARGET_MS;
    this.pacer = deps.pacer ?? new CloudRequestPacer();
    this.cancel.onCancel(() => {
      this.loseWaitingAudio();
    });
    this.unlink = cancel?.onCancel(() => {
      this.cancel.cancel();
    });
  }

  async push(samples: Float32Array, sampleRate: number): Promise<void> {
    if (samples.length === 0 || sampleRate <= 0) return;
    this.throwFailure();
    if (this.cancel.cancelled) {
      if (this.live) return;
      throw new TranscriptionCancelledError();
    }
    if (this.sampleRate === 0) this.sampleRate = sampleRate;
    if (this.stopped) {
      this.lostSamples += samples.length;
      return;
    }
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    if (this.live) {
      this.dropOverflow();
      void this.startPump(false);
      return;
    }
    // Offline: the file is read only as fast as it is uploaded.
    while (this.pendingSamples >= this.regularCutSamples() && this.failure === null) {
      await this.startPump(false);
    }
    this.throwFailure();
  }

  pullAvailable(): Promise<readonly AsrResult[]> {
    return Promise.resolve(this.results.splice(0));
  }

  async drain(): Promise<AsrStreamCoverage> {
    while (this.pump !== null) await this.pump;
    await this.startPump(true);
    this.throwFailure();
    if (this.cancel.cancelled && !this.live) throw new TranscriptionCancelledError();
    return { lostMs: this.msOf(this.lostSamples) };
  }

  dispose(): Promise<void> {
    this.unlink?.();
    this.cancel.cancel();
    this.pending.length = 0;
    this.pendingSamples = 0;
    return Promise.resolve();
  }

  /**
   * Live only, when the stream is cancelled: the uploads end here, so the audio still waiting was
   * never transcribed. It is lost audio, and a `drain` that was waiting reports it; otherwise a
   * draft cut short would pass for the whole recording.
   */
  private loseWaitingAudio(): void {
    if (!this.live || this.pendingSamples === 0) return;
    const lost = this.pendingSamples;
    this.discard(lost);
    this.loseLive(new TranscriptionCancelledError(), lost);
  }

  private loseLive(error: unknown, samples: number): void {
    this.lostSamples += samples;
    this.deps.onLost?.(error, this.msOf(samples));
  }

  private throwFailure(): void {
    if (this.failure !== null) throw this.failure;
  }

  private samplesOf(ms: number): number {
    return Math.round((ms * this.sampleRate) / 1000);
  }

  private msOf(samples: number): number {
    return this.sampleRate === 0 ? 0 : (samples * 1000) / this.sampleRate;
  }

  /** Live only: audio waiting past the limit is dropped, oldest first, and counted as lost. */
  private dropOverflow(): void {
    const limit = this.samplesOf(CLOUD_LIVE_MAX_BUFFERED_MS);
    const before = this.lostSamples;
    while (this.pendingSamples > limit) {
      const excess = this.pendingSamples - limit;
      const head = this.pending[0];
      if (head === undefined) break;
      const dropped = Math.min(excess, head.length);
      this.discard(dropped);
      this.lostSamples += dropped;
    }
    if (this.lostSamples > before) {
      this.deps.onLost?.(null, this.msOf(this.lostSamples - before));
    }
  }

  private startPump(final: boolean): Promise<void> {
    this.pump ??= this.run(final).finally(() => {
      this.pump = null;
    });
    return this.pump;
  }

  /** Sends pieces while there are whole ones (and the tail, when `final`). Never rejects. */
  private async run(final: boolean): Promise<void> {
    while (!this.cancel.cancelled && !this.stopped && this.failure === null) {
      const piece = this.nextPiece(final);
      if (piece === null) return;
      // Silence is covered audio with nothing to show: no request, no wait for a turn, no gap.
      if (isSilentAudio(piece.samples, this.sampleRate)) continue;
      try {
        this.emit(piece, await this.transcribe(piece));
      } catch (error) {
        this.onPieceFailed(piece, error);
      }
    }
    if (this.cancel.cancelled && !this.live && this.failure === null) {
      this.failure = new TranscriptionCancelledError();
    }
  }

  private onPieceFailed(piece: Piece, error: unknown): void {
    if (this.cancel.cancelled) {
      if (!this.live) {
        // The caller is ending the pass: it fails as cancelled, with no transcript to trust.
        this.failure = new TranscriptionCancelledError();
        return;
      }
      // Live: the stream was closed with this piece still out (the stop deadline). Its audio was
      // not transcribed, so it is a gap like any other; what was waiting is already counted.
      this.loseLive(new TranscriptionCancelledError(), piece.samples.length);
      return;
    }
    if (!this.live) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      return;
    }
    let lost = piece.samples.length;
    if (isFatalSpeechFailure(error)) {
      // The key, the account or the model is wrong: every later request would fail the same way.
      this.stopped = true;
      lost += this.pendingSamples;
      this.discard(this.pendingSamples);
    }
    this.loseLive(error, lost);
  }

  /**
   * How much must be buffered before a regular piece is cut. Live cuts at the target, so the text
   * is never later than one piece. Offline waits for the minimum on top of it: what is left after
   * the cut is then never a tail too short to bill, and waiting costs an offline pass nothing.
   */
  private regularCutSamples(): number {
    return this.samplesOf(this.targetMs + (this.live ? 0 : CLOUD_CHUNK_MIN_MS));
  }

  /**
   * The next piece to send, or null when there is not enough audio yet. A regular piece is the
   * target window cut at its quietest point. At the end, what is left goes as one piece unless a
   * regular cut still leaves a tail of at least the minimum.
   */
  private nextPiece(final: boolean): Piece | null {
    if (this.pendingSamples === 0) return null;
    const target = this.samplesOf(this.targetMs);
    const regular =
      this.pendingSamples >=
      (final ? target + this.samplesOf(CLOUD_CHUNK_MIN_MS) : this.regularCutSamples());
    if (!regular && !final) return null;
    if (!regular && this.pendingSamples < this.samplesOf(CLOUD_MIN_UPLOAD_MS)) {
      // The last few samples hold no word and the provider would refuse them: covered silence.
      this.discard(this.pendingSamples);
      return null;
    }
    const count = regular
      ? quietCutSamples(this.head(target), this.sampleRate)
      : this.pendingSamples;
    const piece: Piece = { samples: this.head(count), startSample: this.headSample };
    this.discard(count);
    return piece;
  }

  /** A copy of the first `count` pending samples. */
  private head(count: number): Float32Array {
    const out = new Float32Array(count);
    let filled = 0;
    for (const chunk of this.pending) {
      if (filled >= count) break;
      const part = chunk.subarray(0, count - filled);
      out.set(part, filled);
      filled += part.length;
    }
    return out;
  }

  private discard(count: number): void {
    let left = count;
    while (left > 0) {
      const chunk = this.pending[0];
      if (chunk === undefined) break;
      if (chunk.length <= left) {
        this.pending.shift();
        left -= chunk.length;
      } else {
        this.pending[0] = chunk.subarray(left);
        left = 0;
      }
    }
    this.pendingSamples -= count - left;
    this.headSample += count - left;
  }

  private emit(piece: Piece, answer: SpeechToTextResult): void {
    const text = answer.text.trim();
    // Silence is covered audio with nothing to show.
    if (text === '') return;
    this.previousText = text;
    const offsetMs = Math.round(this.msOf(piece.startSample));
    // The provider's word strings may carry no punctuation or capitals while its text does, and
    // the lines of a long piece are rebuilt from the words. When the text splits into as many
    // tokens as there are words, the tokens are the word texts; the timings stay the provider's.
    const tokens = text.split(/\s+/);
    const paired = tokens.length === answer.words.length;
    this.results.push({
      isFinal: true,
      transcript: text,
      audioProcessedSeconds: this.msOf(piece.startSample + piece.samples.length) / 1000,
      // No speaker tags: a speech-to-text client hears words, not who said them.
      words: answer.words.map((word, index) => ({
        startMs: offsetMs + word.startMs,
        endMs: offsetMs + word.endMs,
        speakerTag: 0,
        text: paired ? (tokens[index] ?? word.text) : word.text,
      })),
    });
  }

  /** One piece, sent again while the failure is one that waiting can fix. */
  private async transcribe(piece: Piece): Promise<SpeechToTextResult> {
    let rateLimited = 0;
    let transient = 0;
    let waitMs = 0;
    for (;;) {
      await this.waitForTurn(waitMs);
      try {
        return await this.request(piece);
      } catch (error) {
        if (this.cancel.cancelled || !isApiProviderError(error)) throw error;
        if (error.kind === 'RateLimited') {
          // The wait is spent before the same piece is sent again, so no request goes out while
          // the provider would refuse it. Live: the audio arriving meanwhile waits in the buffer.
          waitMs = error.retryAfterMs ?? CLOUD_RATE_LIMIT_DEFAULT_WAIT_MS;
          rateLimited += 1;
          const tooLong = !this.live && waitMs > CLOUD_RATE_LIMIT_MAX_WAIT_MS;
          if (tooLong || rateLimited > CLOUD_RATE_LIMIT_MAX_RETRIES) throw error;
        } else if (error.kind === 'Network' || error.kind === 'TimedOut') {
          if (transient >= CLOUD_TRANSIENT_MAX_RETRIES) throw error;
          waitMs = CLOUD_TRANSIENT_BACKOFF_MS * 2 ** transient;
          transient += 1;
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * The request for one piece. It ends when the client answers or the stream is cancelled,
   * whichever comes first: a client that does not answer a cancel must not hold Stop.
   */
  private async request(piece: Piece): Promise<SpeechToTextResult> {
    let unlisten = (): void => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      unlisten = this.cancel.onCancel(() => {
        reject(new TranscriptionCancelledError());
      });
    });
    try {
      return await Promise.race([
        this.deps.client.transcribe(
          {
            samples: piece.samples,
            sampleRate: this.sampleRate,
            language: this.language,
            prompt: promptTail(this.previousText, CLOUD_PROMPT_MAX_CHARS),
          },
          this.cancel.signal,
        ),
        cancelled,
      ]);
    } finally {
      unlisten();
    }
  }

  /** Waits `atLeastMs`, then for this stream's turn with the pacer. */
  private async waitForTurn(atLeastMs: number): Promise<void> {
    const { timer } = this.deps;
    if (atLeastMs > 0) await timer.wait(atLeastMs, this.cancel.signal);
    this.throwIfCancelled();
    const turnMs = this.pacer.take(timer.nowMs());
    if (turnMs > 0) await timer.wait(turnMs, this.cancel.signal);
    this.throwIfCancelled();
  }

  /** A wait that a cancel cut short must not be followed by a request. */
  private throwIfCancelled(): void {
    if (this.cancel.cancelled) throw new TranscriptionCancelledError();
  }
}
