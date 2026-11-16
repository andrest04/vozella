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
import type { CloudSpeechTimer } from './cloud-speech-engine';
import { TranscriptionCancelledError } from './ports';
import type {
  StreamingSpeechProvider,
  StreamingSpeechResult,
  StreamingSpeechSession,
} from './streaming-speech';

/**
 * Audio waiting for the session to open is kept up to this long. A session opens in well under a
 * second, so this only fills when the network is slow; past it the oldest audio is dropped and
 * counted as lost instead of growing without bound.
 */
export const STREAMING_MAX_BUFFERED_MS = 30_000;

/**
 * A session that has not opened this long after it was asked for is given up: it fails as timed
 * out and the pass after Stop transcribes the recording. Shorter than the buffer above, so in
 * practice the buffer never overflows before the session is abandoned.
 */
export const STREAMING_OPEN_TIMEOUT_MS = 15_000;

/**
 * A session that ends cleanly after `finish` may stop this far short of the audio it was sent and
 * still count as having answered for all of it: providers round their clock, and the last few
 * milliseconds hold no word. A larger shortfall is audio nobody listened to, so it counts as lost
 * and the pass after Stop runs. Deepgram confirmed every sample in the run of 2026-11-15.
 */
export const STREAMING_UNCONFIRMED_TOLERANCE_MS = 250;

export interface StreamingSpeechEngineDeps {
  readonly provider: StreamingSpeechProvider;
  /** The wait of the open timeout, so tests need no real time. */
  readonly timer: CloudSpeechTimer;
  /**
   * The pass lost audio: the failure (null for a full buffer, the cancellation for a stream closed
   * before it finished) and how much. The same shape as the cloud speech engine's, so one listener
   * serves both. A session that ends is reported once; audio pushed after it is only counted.
   */
  readonly onLost?: (error: unknown, lostMs: number) => void;
}

/**
 * The streaming speech engine behind the `AsrEngine` port. It knows no provider and no socket: it
 * opens one session per stream with the first audio, sends the audio as it arrives and turns the
 * provider's interim and final results into `AsrResult`s. Any `StreamingSpeechProvider` plugs in.
 *
 * It serves the live pass only. A streaming session listens at the speed of speech, so a finished
 * file goes to the provider's upload endpoint instead (a `SpeechToTextClient` behind the cloud
 * speech engine): asked for the `offline` profile, `createRecognizer` rejects, and whoever selects
 * the engine of a pass routes offline passes away from this one.
 *
 * A session that ends early is not opened again: the audio after its last final result counts as
 * lost, later audio too, and the pass after Stop covers the recording.
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
 * straight to the session. `finishing`: no more audio, waiting for the last results. `ended`: over.
 */
type Phase = 'idle' | 'connecting' | 'open' | 'finishing' | 'ended';

class StreamingSpeechStream implements AsrStream {
  private readonly cancel = new CancelSource();
  private readonly unlink: (() => void) | undefined;
  /** Cancelled when the session opens or ends, which stops the open timeout. */
  private readonly opening = new CancelSource();
  private phase: Phase = 'idle';
  private session: StreamingSpeechSession | null = null;
  /**
   * The rate of the first frame. The session is opened with it and every later frame is taken to
   * have it, as the cloud speech engine does: the capture mixes to one rate for a whole recording.
   */
  private sampleRate = 0;
  /** Audio pushed before the session opened, oldest first. */
  private readonly waiting: Float32Array[] = [];
  private waitingSamples = 0;
  /** Waiting audio dropped before the session opened: the provider's clock starts after it. */
  private droppedSamples = 0;
  private sentSamples = 0;
  /** How far the provider's final results reach, on its own clock. */
  private confirmedMs = 0;
  private lostMs = 0;
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
    if (this.phase === 'open' && !this.finishWanted) {
      this.send(samples);
    } else if ((this.phase === 'idle' || this.phase === 'connecting') && !this.finishWanted) {
      this.waiting.push(samples);
      this.waitingSamples += samples.length;
      if (this.phase === 'idle') this.connect();
      else this.dropOverflow();
    } else {
      // The session is over or finishing: nothing will listen to this audio.
      this.lostMs += this.msOf(samples.length);
    }
    return Promise.resolve();
  }

  pullAvailable(): Promise<readonly AsrResult[]> {
    return Promise.resolve(this.results.splice(0));
  }

  /**
   * Finishes the session and waits for its last final results. Resolves with the audio that was
   * pushed and never confirmed; exactly zero when the provider answered for all of it.
   */
  async drain(): Promise<AsrStreamCoverage> {
    if (this.phase !== 'idle' && this.phase !== 'ended') {
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
    let session: StreamingSpeechSession;
    try {
      session = this.deps.provider.open(
        { language: this.language, sampleRate: this.sampleRate, cancel: this.cancel.signal },
        {
          opened: () => {
            this.onOpened();
          },
          interim: (result) => {
            this.onResult(result, false);
          },
          final: (result) => {
            this.onResult(result, true);
          },
          closed: (error) => {
            this.onClosed(error);
          },
        },
      );
    } catch (error) {
      this.abandon(error, false);
      return;
    }
    // A provider may open, or fail, before `open` returns.
    const phase = this.currentPhase();
    if (phase === 'ended') return;
    this.session = session;
    if (phase === 'open') this.flush();
    else this.startOpenTimeout();
  }

  private startOpenTimeout(): void {
    const { timer, provider } = this.deps;
    void timer.wait(STREAMING_OPEN_TIMEOUT_MS, this.opening.signal).then(
      () => {
        if (this.opening.cancelled || this.phase !== 'connecting') return;
        this.abandon(new ApiProviderError(provider.displayName, 'TimedOut'), true);
      },
      () => undefined,
    );
  }

  private onOpened(): void {
    if (this.phase !== 'connecting') return;
    this.phase = 'open';
    this.opening.cancel();
    // Still inside `provider.open`: `connect` flushes once it holds the session.
    if (this.session !== null) this.flush();
  }

  /** Sends what waited for the open, oldest first, then finishes if a drain is waiting. */
  private flush(): void {
    for (;;) {
      const samples = this.waiting.shift();
      if (samples === undefined) break;
      this.waitingSamples -= samples.length;
      this.send(samples);
    }
    if (this.finishWanted && this.currentPhase() === 'open') this.finish();
  }

  private send(samples: Float32Array): void {
    if (this.phase !== 'open' || this.session === null) {
      this.lostMs += this.msOf(samples.length);
      return;
    }
    // Counted before the call: a session that ends inside `send` never confirmed this frame.
    this.sentSamples += samples.length;
    try {
      this.session.send(samples);
    } catch (error) {
      this.abandon(error, true);
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

  /** Audio waiting past the limit is dropped, oldest first, and counted as lost. */
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
    this.droppedSamples += dropped;
    this.lostMs += this.msOf(dropped);
    this.deps.onLost?.(null, this.msOf(dropped));
  }

  private onResult(result: StreamingSpeechResult, isFinal: boolean): void {
    if (this.phase !== 'open' && this.phase !== 'finishing') return;
    // A final with no words is silence the provider listened to: covered, with nothing to show.
    if (isFinal) this.confirmedMs = Math.max(this.confirmedMs, result.processedMs);
    // The provider counts from the first sample it was sent; the stream from the first pushed.
    const offsetMs = Math.round(this.msOf(this.droppedSamples));
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
    this.lose(error ?? new ApiProviderError(this.deps.provider.displayName, 'Network'));
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
    this.end();
    this.deps.onLost?.(
      new ApiProviderError(
        this.deps.provider.displayName,
        'Unknown',
        'The session ended before it answered for all the audio.',
      ),
      shortfall,
    );
  }

  /** The session is given up from this side: it is closed, and what it had not confirmed is lost. */
  private abandon(error: unknown, always: boolean): void {
    if (this.phase === 'ended') return;
    if (this.phase === 'idle') {
      this.end();
      return;
    }
    const session = this.session;
    this.lose(error, always);
    try {
      session?.close();
    } catch {
      // Closing a session that is already gone has nothing to report.
    }
  }

  /**
   * Ends the session with a failure. Lost: what waited for the open, and what was sent after the
   * last final result. Reported once; `always` false skips the report when nothing was lost (a
   * stream closed after its session ended cleanly has no gap to log).
   */
  private lose(error: unknown, always = true): void {
    const lost =
      this.msOf(this.waitingSamples) + Math.max(0, this.msOf(this.sentSamples) - this.confirmedMs);
    this.waiting.length = 0;
    this.waitingSamples = 0;
    this.lostMs += lost;
    this.end();
    if (always || lost > 0) this.deps.onLost?.(error, lost);
  }

  private end(): void {
    this.phase = 'ended';
    this.session = null;
    this.opening.cancel();
    for (const resolve of this.ended.splice(0)) resolve();
  }
}
