import { CancelSource, type CancelSignal } from '../cancel';
import { StreamingTranscriptAccumulator } from './accumulator';
import type { AsrRecognizer, AsrStream } from './asr-types';
import { STREAMING_GEOMETRY } from './asr-types';
import type { AsrBackendStatus } from './backend-status';
import type { RecognizerSource } from './recognizer-factory';
import { engineLocaleFor } from '../settings/languages';
import { MIC_ACTIVITY_FRAME_MS, MicActivityRecorder, type SourceLevels } from './mic-activity';

export interface LiveTranscriptUpdate {
  /** Committed lines plus the rewritten interim suffix. */
  readonly displayText: string;
  /** Finals only. A change here means a new line; an interim rewrite does not. */
  readonly committedText: string;
}

export interface LiveStartOptions {
  /** Language code of the setting (`es`, `auto`); mapped to an engine locale here. */
  readonly language: string | null;
  readonly recordedAtMs: number | null;
  readonly speakerDiarization: boolean;
}

export interface LiveServiceDeps {
  /** The engine of the session: the local factory, or whichever engine is selected when it starts. */
  readonly factory: RecognizerSource;
  readonly status?: AsrBackendStatus;
  /** Where errors that must not stop the recording go (native calls, a throwing listener). */
  readonly onError?: (error: unknown) => void;
  /**
   * The wait of the stop deadline: resolves after `ms`, or as soon as `cancel` fires. Only an
   * engine that drains at Stop (a cloud engine) is given a deadline; without this there is none.
   */
  readonly stopWait?: (ms: number, cancel: CancelSignal) => Promise<void>;
}

/** Frames waiting for the engine. The capture side never waits. */
export const LIVE_QUEUE_CAPACITY = 8;

/**
 * How long Stop waits for an engine that is still transcribing what it buffered. The meeting is
 * saved only after the live pass ends, so uploads that stalled or were rate limited while
 * recording (up to five minutes of audio, each piece with its own retries) must not hold it.
 * 25 seconds lets a healthy tail finish (one request, after the pacing of the one before it);
 * past it the stream is closed, what it had not transcribed counts as lost audio, and the pass
 * after Stop transcribes the recording instead.
 */
export const LIVE_STOP_DEADLINE_MS = 25_000;

interface Frame {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** Source levels per {@link MIC_ACTIVITY_FRAME_MS}, measured before mixing; absent: unknown. */
  readonly levels: readonly SourceLevels[] | undefined;
}

interface Session {
  readonly recognizer: AsrRecognizer;
  readonly stream: AsrStream;
  readonly accumulator: StreamingTranscriptAccumulator;
  /** Microphone activity in engine time. The accumulator reads it only while speaker labels run. */
  readonly micActivity: MicActivityRecorder;
  /** Some frame that reached the engine carried source levels. */
  levelsSeen: boolean;
  readonly queue: Frame[];
  wake: (() => void) | null;
  closed: boolean;
  totalMs: number;
  droppedMs: number;
  /** A push or a pull failed, so some audio may never have reached the engine. */
  faulted: boolean;
  worker: Promise<void>;
}

const frameMs = (frame: Frame): number =>
  frame.sampleRate > 0 ? (frame.samples.length * 1000) / frame.sampleRate : 0;

/**
 * Live recognition while recording. `pushFrame` only queues; one loop feeds the engine, so a slow
 * backend drops the oldest audio instead of slowing the recording. Start and Stop are serialized.
 * The stream is closed without `finish`.
 */
export class LiveTranscriptionService {
  private session: Session | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private draftComplete = false;
  private readonly listeners = new Set<(update: LiveTranscriptUpdate) => void>();

  constructor(private readonly deps: LiveServiceDeps) {}

  get isRunning(): boolean {
    return this.session !== null && !this.session.closed;
  }

  /**
   * True when the draft of the last stopped session is the transcript of all its audio: the
   * engine drained and reported nothing lost, no frame was dropped on the way to it, and no call
   * failed. Only an engine that can drain (the cloud engine) can say so; with the local engine it
   * is always false, so the pass after Stop runs as before.
   */
  get lastDraftIsComplete(): boolean {
    return this.draftComplete;
  }

  onTranscriptUpdated(listener: (update: LiveTranscriptUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops a running session, then loads the model and opens the stream. */
  start(options: LiveStartOptions): Promise<void> {
    return this.serialize(async () => {
      await this.stopNow();
      this.draftComplete = false;
      const created = await this.deps.factory.create({
        enableDiarization: options.speakerDiarization,
        geometry: STREAMING_GEOMETRY,
        latency: 'live',
      });
      let stream: AsrStream;
      try {
        stream = await created.recognizer.startStream({
          language: engineLocaleFor(options.language),
          interimResults: true,
          diarization: created.diarization,
        });
      } catch (error) {
        await created.recognizer.dispose().catch(() => undefined);
        throw error;
      }
      const micActivity = new MicActivityRecorder();
      const session: Session = {
        recognizer: created.recognizer,
        stream,
        // Only speaker labels name `[ You ]`; without them the transcript stays untagged.
        accumulator: new StreamingTranscriptAccumulator(options.recordedAtMs, {
          micActivity: created.diarization ? micActivity : null,
        }),
        micActivity,
        levelsSeen: false,
        queue: [],
        wake: null,
        closed: false,
        totalMs: 0,
        droppedMs: 0,
        faulted: false,
        worker: Promise.resolve(),
      };
      session.worker = this.run(session);
      this.session = session;
    });
  }

  /**
   * Called for every capture frame. Never waits for the engine. `levels` are the microphone and
   * output levels of the frame before mixing, which name the local user `[ You ]`.
   */
  pushFrame(samples: Float32Array, sampleRate: number, levels?: readonly SourceLevels[]): void {
    const session = this.session;
    if (!session || session.closed) return;
    const frame: Frame = { samples, sampleRate, levels };
    session.totalMs += frameMs(frame);
    if (session.queue.length >= LIVE_QUEUE_CAPACITY) {
      const dropped = session.queue.shift();
      if (dropped) session.droppedMs += frameMs(dropped);
    }
    session.queue.push(frame);
    session.wake?.();
  }

  /**
   * How much of a span (engine time, ms) the microphone dominated, 0..1, whatever the speaker
   * labels setting. Type at cursor reads it to tell the local user's lines from the others'.
   * Reads only the current session: null when none runs or no frame has carried levels yet.
   */
  micDominantShare(startMs: number, endMs: number): number | null {
    const session = this.session;
    if (!session?.levelsSeen) return null;
    return session.micActivity.dominantShare(startMs, endMs);
  }

  /** Commits the leftover interim, closes the engine objects and returns the committed text. */
  stop(): Promise<string> {
    return this.serialize(() => this.stopNow());
  }

  private async stopNow(): Promise<string> {
    // What the take before this one left says nothing about this Stop, session or not.
    this.draftComplete = false;
    const session = this.session;
    if (!session) return '';
    session.closed = true;
    session.wake?.();
    await session.worker;
    this.session = null;
    const lostMs = await this.drain(session);
    session.accumulator.commitRemainingInterim();
    const text = session.accumulator.committedText;
    this.draftComplete =
      lostMs === 0 && session.droppedMs === 0 && !session.faulted && text.trim() !== '';
    try {
      await session.stream.dispose();
    } finally {
      await session.recognizer.dispose();
      this.deps.status?.reportLiveDrops({
        // Audio the engine was given and lost is skipped audio too.
        droppedMs: session.droppedMs + (lostMs ?? 0),
        totalMs: session.totalMs,
      });
    }
    return text;
  }

  /**
   * An engine that works in pieces transcribes its last one now, and the session waits for it.
   * Returns the audio the engine lost, or null when the engine cannot say (the local one, which
   * has nothing to drain, or a drain that failed).
   *
   * The wait has a deadline ({@link LIVE_STOP_DEADLINE_MS}). Past it the stream is closed, which
   * cancels its uploads; the drain then ends at once and reports what was cut off as lost.
   */
  private async drain(session: Session): Promise<number | null> {
    const { stream } = session;
    if (!stream.drain) return null;
    const ended = new CancelSource();
    try {
      const draining = stream.drain();
      void this.deps.stopWait?.(LIVE_STOP_DEADLINE_MS, ended.signal).then(
        () => {
          if (ended.cancelled) return;
          this.deps.onError?.(new Error('live transcription was cut off at the stop deadline'));
          void stream.dispose().catch(() => undefined);
        },
        () => undefined,
      );
      const coverage = await draining;
      let changed = false;
      for (const result of await stream.pullAvailable()) {
        session.accumulator.apply(result);
        changed = true;
      }
      if (changed) this.emit(session);
      return coverage.lostMs;
    } catch (error) {
      this.deps.onError?.(error);
      return null;
    } finally {
      ended.cancel();
    }
  }

  private async run(session: Session): Promise<void> {
    for (;;) {
      const frame = session.queue.shift();
      if (!frame) {
        if (session.closed) return;
        await new Promise<void>((resolve) => {
          session.wake = resolve;
          // A frame may have arrived while the promise was being created.
          if (session.queue.length > 0 || session.closed) resolve();
        });
        session.wake = null;
        continue;
      }
      let changed = false;
      // Recorded when the frame reaches the engine, so a dropped frame shifts neither timeline.
      recordLevels(session.micActivity, frame);
      if (frame.levels !== undefined && frame.levels.length > 0) session.levelsSeen = true;
      try {
        await session.stream.push(frame.samples, frame.sampleRate);
        for (const result of await session.stream.pullAvailable()) {
          session.accumulator.apply(result);
          changed = true;
        }
      } catch (error) {
        // The recording must survive a native error; a later frame or Stop may still produce text.
        session.faulted = true;
        this.deps.onError?.(error);
      }
      if (changed) this.emit(session);
    }
  }

  private emit(session: Session): void {
    const update: LiveTranscriptUpdate = {
      displayText: session.accumulator.displayText,
      committedText: session.accumulator.committedText,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(update);
      } catch (error) {
        // A throwing subscriber must not fault the loop and leave the engine open.
        this.deps.onError?.(error);
      }
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(task, task);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }
}

/**
 * Keeps the activity aligned with the audio the engine heard: one level per
 * {@link MIC_ACTIVITY_FRAME_MS} of the frame, silence where levels are missing or short.
 */
function recordLevels(recorder: MicActivityRecorder, frame: Frame): void {
  const count = Math.round(frameMs(frame) / MIC_ACTIVITY_FRAME_MS);
  for (let i = 0; i < count; i += 1) {
    recorder.push(frame.levels?.[i] ?? SILENCE);
  }
}

const SILENCE: SourceLevels = { microphone: 0, output: 0 };
