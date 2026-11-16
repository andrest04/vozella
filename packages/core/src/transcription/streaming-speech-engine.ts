import { CancelSource, type CancelSignal } from '../cancel';
import { ApiProviderError } from '../summaries/api-failure';
import type {
  AsrEngine,
  AsrRecognizer,
  AsrResult,
  AsrStream,
  AsrStreamCoverage,
  RecognizerSettings,
  StreamOptions,
} from './asr-types';
import { isFatalSpeechFailure, type CloudSpeechTimer } from './cloud-speech-engine';
import { TranscriptionCancelledError } from './ports';
import type {
  StreamingSpeechProvider,
  StreamingSpeechResult,
  StreamingSpeechSession,
} from './streaming-speech';

/**
 * Audio waiting for a session to open is kept up to this long. A session opens in well under a
 * second, so this only fills when the network is slow or down; past it the oldest audio is dropped
 * and counted as lost instead of growing without bound.
 */
export const STREAMING_MAX_BUFFERED_MS = 30_000;

/**
 * A session that has not opened this long after it was asked for is given up: the try fails as
 * timed out and, like any other drop, another one follows. Shorter than the buffer above, so one
 * slow try does not overflow the buffer.
 */
export const STREAMING_OPEN_TIMEOUT_MS = 15_000;

/**
 * A session that ends cleanly after `finish` may stop this far short of the audio it was sent and
 * still count as having answered for all of it: providers round their clock, and the last few
 * milliseconds hold no word. A larger shortfall is audio nobody listened to, so it counts as lost
 * and the pass after Stop runs. Deepgram confirmed every sample in the run of 2026-11-15.
 */
export const STREAMING_UNCONFIRMED_TOLERANCE_MS = 250;

/**
 * How long the stream waits before it opens a new session after one dropped: one entry per try in
 * a row that failed, the last one for every try after it. A session that gives a final result
 * worked, and the next drop starts from the first entry again.
 */
export const STREAMING_REOPEN_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];

export interface StreamingSpeechEngineDeps {
  readonly provider: StreamingSpeechProvider;
  /** The waits of the open timeout and between tries to reopen, so tests need no real time. */
  readonly timer: CloudSpeechTimer;
  /**
   * The pass lost audio, or a session dropped: the failure (null for a full buffer, the
   * cancellation for a stream closed before it finished) and how much audio was lost since the
   * last report. The same shape as the cloud speech engine's, so one listener serves both. A
   * drop is reported when it happens (with zero when nothing was lost); while the stream stays
   * down, the tries that fail are reported only when audio was lost meanwhile. Audio pushed
   * after the stream ended is only counted.
   */
  readonly onLost?: (error: unknown, lostMs: number) => void;
}

/**
 * The streaming speech engine behind the `AsrEngine` port. It knows no provider and no socket: it
 * opens a session with the first audio, sends the audio as it arrives and turns the provider's
 * interim and final results into `AsrResult`s. Any `StreamingSpeechProvider` plugs in.
 *
 * It serves the live pass only. A streaming session listens at the speed of speech, so a finished
 * file goes to the provider's upload endpoint instead (a `SpeechToTextClient` behind the cloud
 * speech engine): asked for the `offline` profile, `createRecognizer` rejects, and whoever selects
 * the engine of a pass routes offline passes away from this one.
 *
 * A session that drops while the stream is live is replaced: the audio it was sent after its last
 * final result counts as lost (so the pass after Stop still runs), the audio pushed meanwhile
 * waits for the next session, and the results of that session are shifted to where it started in
 * the stream, because its own clock starts at zero. A failure waiting cannot fix (the key, the
 * account, the model) ends the stream instead, as does a drop once Stop is waiting.
 */
export class StreamingSpeechEngine implements AsrEngine {
  constructor(private readonly deps: StreamingSpeechEngineDeps) {}

  /** `cancel` ends the session at once; what it had not confirmed counts as lost. */
  createRecognizer(
    settings: Pick<RecognizerSettings, 'latency'>,
    cancel?: CancelSignal,
  ): Promise<AsrRecognizer> {
    if (settings.latency !== 'live') {
      return Promise.reject(new Error('A streaming speech engine serves the live pass only.'));
    }
    const { deps } = this;
    return Promise.resolve({
      startStream: (options: StreamOptions): Promise<AsrStream> =>
        Promise.resolve(new StreamingSpeechStream(deps, options.language, cancel)),
      dispose: () => Promise.resolve(),
    });
  }
}

/**
 * `idle`: no audio yet, no session. `connecting`: asked for, audio waits. `open`: audio goes
 * straight to the session. `reopening`: the session dropped, audio waits for the next try.
 * `finishing`: no more audio, waiting for the last results. `ended`: over.
 */
type Phase = 'idle' | 'connecting' | 'open' | 'reopening' | 'finishing' | 'ended';

function closeQuietly(session: StreamingSpeechSession | null): void {
  try {
    session?.close();
  } catch {
    // Closing a session that is already gone has nothing to report.
  }
}

class StreamingSpeechStream implements AsrStream {
  private readonly cancel = new CancelSource();
  private readonly unlink: (() => void) | undefined;
  /** Stops the wait of the current try: its open timeout, or the pause before the next try. */
  private pending = new CancelSource();
  private phase: Phase = 'idle';
  private session: StreamingSpeechSession | null = null;
  /** Grows each time a session is let go, so what that session says afterwards is ignored. */
  private generation = 0;
  /**
   * The rate of the first frame. Every session is opened with it and every later frame is taken to
   * have it, as the cloud speech engine does: the capture mixes to one rate for a whole recording.
   */
  private sampleRate = 0;
  /** Audio pushed while no session was open, oldest first. */
  private readonly waiting: Float32Array[] = [];
  private waitingSamples = 0;
  /**
   * Where in the stream the first sample of the current session is, or will be: the audio sent to
   * the sessions before it plus the waiting audio that was dropped. Its clock starts there.
   */
  private sessionStartSamples = 0;
  /** Audio sent to the current session. */
  private sentSamples = 0;
  /** How far the final results of the current session reach, on its own clock. */
  private confirmedMs = 0;
  private lostMs = 0;
  /** The part of `lostMs` not yet told to `onLost`. */
  private unreportedMs = 0;
  /** Tries in a row that ended without a final result; picks the wait before the next one. */
  private failedTries = 0;
  /** Why the last session dropped: the reason given if Stop finds the stream still down. */
  private lastFailure: unknown = null;
  /** `drain` was called: the session is finished as soon as it is open. */
  private finishWanted = false;
  /** An interim result with text was handed over and nothing has replaced it yet. */
  private interimShown = false;
  private readonly results: AsrResult[] = [];
  private readonly ended: (() => void)[] = [];

  constructor(
    private readonly deps: StreamingSpeechEngineDeps,
    private readonly language: string,
    cancel: CancelSignal | undefined,
  ) {
    this.cancel.onCancel(() => {
      this.abandon(new TranscriptionCancelledError(), false);
    });
    this.unlink = cancel?.onCancel(() => {
      this.cancel.cancel();
    });
  }

  /** Never throws and never waits: the audio is sent, kept for the open, or counted as lost. */
  push(samples: Float32Array, sampleRate: number): Promise<void> {
    if (samples.length === 0 || sampleRate <= 0 || this.cancel.cancelled) return Promise.resolve();
    if (this.sampleRate === 0) this.sampleRate = sampleRate;
    const canWait =
      this.phase === 'idle' || this.phase === 'connecting' || this.phase === 'reopening';
    if (this.phase === 'open' && !this.finishWanted) {
      this.send(samples);
    } else if (canWait && !this.finishWanted) {
      this.waiting.push(samples);
      this.waitingSamples += samples.length;
      if (this.phase === 'idle') this.connect();
      else this.dropOverflow();
    } else {
      // The stream is over or finishing: nothing will listen to this audio.
      this.lostMs += this.msOf(samples.length);
    }
    return Promise.resolve();
  }

  pullAvailable(): Promise<readonly AsrResult[]> {
    return Promise.resolve(this.results.splice(0));
  }

  /**
   * Finishes the session and waits for its last final results. Resolves with the audio that was
   * pushed and never confirmed; exactly zero when the provider answered for all of it. A stream
   * that is down ends at once: Stop does not wait for a session that may never open.
   */
  async drain(): Promise<AsrStreamCoverage> {
    if (this.phase === 'reopening') {
      this.lose(this.lastFailure, false);
    } else if (this.phase !== 'idle' && this.phase !== 'ended') {
      this.finishWanted = true;
      if (this.phase === 'open') this.finish();
      // `finish` may have ended the session already (a provider that answers at once).
      if (this.currentPhase() !== 'ended') {
        await new Promise<void>((resolve) => {
          this.ended.push(resolve);
        });
      }
    }
    return { lostMs: this.lostMs };
  }

  dispose(): Promise<void> {
    this.unlink?.();
    this.cancel.cancel();
    return Promise.resolve();
  }

  /** The phase as a plain value, where a narrowed `this.phase` would hide a change made by a call. */
  private currentPhase(): Phase {
    return this.phase;
  }

  private msOf(samples: number): number {
    return this.sampleRate === 0 ? 0 : (samples * 1000) / this.sampleRate;
  }

  private connect(): void {
    this.phase = 'connecting';
    const generation = this.generation;
    const current = (): boolean => this.generation === generation;
    let session: StreamingSpeechSession;
    try {
      session = this.deps.provider.open(
        { language: this.language, sampleRate: this.sampleRate, cancel: this.cancel.signal },
        {
          opened: () => {
            if (current()) this.onOpened();
          },
          interim: (result) => {
            if (current()) this.onResult(result, false);
          },
          final: (result) => {
            if (current()) this.onResult(result, true);
          },
          closed: (error) => {
            if (current()) this.onClosed(error);
          },
        },
      );
    } catch (error) {
      this.drop(error, false);
      return;
    }
    // A provider may open, or fail, before `open` returns; one that failed is already let go.
    if (!current()) return;
    this.session = session;
    if (this.currentPhase() === 'open') this.flush();
    else this.startOpenTimeout();
  }

  private startOpenTimeout(): void {
    const { timer, provider } = this.deps;
    const waiting = (this.pending = new CancelSource());
    void timer.wait(STREAMING_OPEN_TIMEOUT_MS, waiting.signal).then(
      () => {
        if (waiting.cancelled || this.phase !== 'connecting') return;
        this.drop(new ApiProviderError(provider.displayName, 'TimedOut'), true);
      },
      () => undefined,
    );
  }

  private onOpened(): void {
    if (this.phase !== 'connecting') return;
    this.phase = 'open';
    this.pending.cancel();
    // Waiting audio dropped while no session was open is told once, here, not frame by frame.
    if (this.unreportedMs > 0) this.report(null);
    // Still inside `provider.open`: `connect` flushes once it holds the session.
    if (this.session !== null) this.flush();
  }

  /** Sends what waited for the open, oldest first, then finishes if a drain is waiting. */
  private flush(): void {
    // A session that drops while it is being sent to leaves the rest waiting for the next one.
    while (this.currentPhase() === 'open') {
      const samples = this.waiting.shift();
      if (samples === undefined) break;
      this.waitingSamples -= samples.length;
      this.send(samples);
    }
    if (this.finishWanted && this.currentPhase() === 'open') this.finish();
  }

  private send(samples: Float32Array): void {
    const session = this.session;
    if (this.phase !== 'open' || session === null) {
      this.lostMs += this.msOf(samples.length);
      return;
    }
    // Counted before the call: a session that ends inside `send` never confirmed this frame.
    this.sentSamples += samples.length;
    try {
      session.send(samples);
    } catch (error) {
      if (this.session === session) this.drop(error, true);
    }
  }

  private finish(): void {
    this.phase = 'finishing';
    try {
      this.session?.finish();
    } catch (error) {
      this.abandon(error, true);
    }
  }

  /**
   * Audio waiting past the limit is dropped, oldest first, and counted as lost. It is before the
   * first sample the next session will hear, so that session starts later in the stream.
   */
  private dropOverflow(): void {
    const limit = Math.round((STREAMING_MAX_BUFFERED_MS * this.sampleRate) / 1000);
    let dropped = 0;
    while (this.waitingSamples > limit) {
      const head = this.waiting[0];
      if (head === undefined) break;
      const count = Math.min(this.waitingSamples - limit, head.length);
      if (count === head.length) this.waiting.shift();
      else this.waiting[0] = head.subarray(count);
      this.waitingSamples -= count;
      dropped += count;
    }
    if (dropped === 0) return;
    this.sessionStartSamples += dropped;
    this.lostMs += this.msOf(dropped);
    // Reported when the session opens, the try fails or the stream ends: a stream that is down
    // for minutes would otherwise report every frame.
    this.unreportedMs += this.msOf(dropped);
  }

  private onResult(result: StreamingSpeechResult, isFinal: boolean): void {
    if (this.phase !== 'open' && this.phase !== 'finishing') return;
    if (isFinal) {
      // A final with no words is silence the provider listened to: covered, with nothing to show.
      this.confirmedMs = Math.max(this.confirmedMs, result.processedMs);
      // The session works, so the next drop is retried quickly again.
      this.failedTries = 0;
    }
    // The session counts from the first sample it was sent; the stream from the first pushed.
    const offsetMs = Math.round(this.msOf(this.sessionStartSamples));
    if (result.words.length === 0) {
      // Nothing was said. If interim text is on screen the provider took it back (an "uh" that
      // ended as an empty final): an empty result withdraws it, so Stop cannot save it.
      if (!this.interimShown) return;
      this.interimShown = false;
      this.results.push({
        isFinal,
        transcript: '',
        audioProcessedSeconds: (offsetMs + result.processedMs) / 1000,
        words: [],
      });
      return;
    }
    this.interimShown = !isFinal;
    const text = result.text.trim();
    this.results.push({
      isFinal,
      transcript: text === '' ? result.words.map((word) => word.text).join(' ') : text,
      audioProcessedSeconds: (offsetMs + result.processedMs) / 1000,
      // No speaker tags: a streaming provider is asked for words, not for who said them.
      words: result.words.map((word) => ({
        startMs: offsetMs + Math.round(word.startMs),
        endMs: offsetMs + Math.round(word.endMs),
        speakerTag: 0,
        text: word.text,
      })),
    });
  }

  private onClosed(error: ApiProviderError | null): void {
    if (this.phase === 'ended') return;
    if (error === null && this.phase === 'finishing') {
      this.endFinished();
      return;
    }
    // Ending without being asked to is a dropped connection, whatever the provider calls it.
    this.drop(error ?? new ApiProviderError(this.deps.provider.displayName, 'Network'), false);
  }

  /**
   * The session ended cleanly after `finish`. It is taken at its word only as far as its final
   * results reach: audio sent beyond them, past the tolerance, was never listened to and is lost.
   */
  private endFinished(): void {
    const shortfall = this.msOf(this.sentSamples) - this.confirmedMs;
    if (shortfall <= STREAMING_UNCONFIRMED_TOLERANCE_MS) {
      this.end();
      return;
    }
    this.lostMs += shortfall;
    this.unreportedMs += shortfall;
    this.end();
    this.report(
      new ApiProviderError(
        this.deps.provider.displayName,
        'Unknown',
        'The session ended before it answered for all the audio.',
      ),
    );
  }

  /**
   * The session is gone, or never opened. While the stream is live and waiting can fix the
   * failure, another session is opened after a pause: what this one was sent after its last final
   * result is lost, the audio that waits is kept for the next one, and that one starts where this
   * one stopped. Otherwise the stream ends. `close` says the session has to be closed from here.
   */
  private drop(error: unknown, close: boolean): void {
    const session = this.session;
    if (this.finishWanted || this.cancel.cancelled || isFatalSpeechFailure(error)) {
      this.lose(error);
      if (close) closeQuietly(session);
      return;
    }
    const unconfirmed = Math.max(0, this.msOf(this.sentSamples) - this.confirmedMs);
    this.lostMs += unconfirmed;
    this.unreportedMs += unconfirmed;
    this.sessionStartSamples += this.sentSamples;
    this.sentSamples = 0;
    this.confirmedMs = 0;
    this.detach();
    this.phase = 'reopening';
    this.lastFailure = error;
    // The drop itself is told once; the tries that fail after it only when audio was lost.
    const tell = this.failedTries === 0 || this.unreportedMs > 0;
    const delays = STREAMING_REOPEN_DELAYS_MS;
    const delayMs = delays[Math.min(this.failedTries, delays.length - 1)] ?? 0;
    this.failedTries += 1;
    const waiting = (this.pending = new CancelSource());
    void this.deps.timer.wait(delayMs, waiting.signal).then(
      () => {
        if (waiting.cancelled || this.phase !== 'reopening') return;
        this.connect();
      },
      () => undefined,
    );
    if (close) closeQuietly(session);
    if (tell) this.report(error);
  }

  /** The stream is given up from this side: its session is closed, the unconfirmed audio lost. */
  private abandon(error: unknown, always: boolean): void {
    if (this.phase === 'ended') return;
    if (this.phase === 'idle') {
      this.end();
      return;
    }
    const session = this.session;
    this.lose(error, always);
    closeQuietly(session);
  }

  /**
   * Ends the stream with a failure. Lost: what waited for a session, and what was sent after the
   * last final result. Reported once; `always` false skips the report when nothing is left to
   * tell (a stream closed after its session ended cleanly has no gap to log).
   */
  private lose(error: unknown, always = true): void {
    const lost =
      this.msOf(this.waitingSamples) + Math.max(0, this.msOf(this.sentSamples) - this.confirmedMs);
    this.waiting.length = 0;
    this.waitingSamples = 0;
    this.lostMs += lost;
    this.unreportedMs += lost;
    this.end();
    if (always || this.unreportedMs > 0) this.report(error);
  }

  /** Tells `onLost` the audio lost since it was last told. */
  private report(error: unknown): void {
    const lostMs = this.unreportedMs;
    this.unreportedMs = 0;
    this.deps.onLost?.(error, lostMs);
  }

  /** Lets the session go: it is no longer heard, and the wait of its try stops. */
  private detach(): void {
    this.session = null;
    this.generation += 1;
    this.pending.cancel();
  }

  private end(): void {
    this.phase = 'ended';
    this.detach();
    for (const resolve of this.ended.splice(0)) resolve();
  }
}
