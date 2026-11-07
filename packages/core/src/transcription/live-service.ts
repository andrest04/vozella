import { StreamingTranscriptAccumulator } from './accumulator';
import type { AsrRecognizer, AsrStream } from './asr-types';
import { STREAMING_GEOMETRY } from './asr-types';
import type { AsrBackendStatus } from './backend-status';
import type { NemoSpeechRecognizerFactory } from './recognizer-factory';
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
  readonly factory: NemoSpeechRecognizerFactory;
  readonly status?: AsrBackendStatus;
  /** Where errors that must not stop the recording go (native calls, a throwing listener). */
  readonly onError?: (error: unknown) => void;
}

/** Frames waiting for the engine. The capture side never waits (spec 3.10). */
export const LIVE_QUEUE_CAPACITY = 8;

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
  /** Microphone activity in engine time, only while speaker labels run. */
  readonly micActivity: MicActivityRecorder | null;
  readonly queue: Frame[];
  wake: (() => void) | null;
  closed: boolean;
  totalMs: number;
  droppedMs: number;
  worker: Promise<void>;
}

const frameMs = (frame: Frame): number =>
  frame.sampleRate > 0 ? (frame.samples.length * 1000) / frame.sampleRate : 0;

/**
 * Live recognition while recording. `pushFrame` only queues; one loop feeds the engine, so a slow
 * backend drops the oldest audio instead of slowing the recording. Start and Stop are serialized
 * (B12). The stream is closed without `finish` (spec 5.3).
 */
export class LiveTranscriptionService {
  private session: Session | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(update: LiveTranscriptUpdate) => void>();

  constructor(private readonly deps: LiveServiceDeps) {}

  get isRunning(): boolean {
    return this.session !== null && !this.session.closed;
  }

  onTranscriptUpdated(listener: (update: LiveTranscriptUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops a running session, then loads the model and opens the stream. */
  start(options: LiveStartOptions): Promise<void> {
    return this.serialize(async () => {
      await this.stopNow();
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
      const micActivity = created.diarization ? new MicActivityRecorder() : null;
      const session: Session = {
        recognizer: created.recognizer,
        stream,
        accumulator: new StreamingTranscriptAccumulator(options.recordedAtMs, { micActivity }),
        micActivity,
        queue: [],
        wake: null,
        closed: false,
        totalMs: 0,
        droppedMs: 0,
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

  /** Commits the leftover interim, closes the engine objects and returns the committed text. */
  stop(): Promise<string> {
    return this.serialize(() => this.stopNow());
  }

  private async stopNow(): Promise<string> {
    const session = this.session;
    if (!session) return '';
    session.closed = true;
    session.wake?.();
    await session.worker;
    this.session = null;
    session.accumulator.commitRemainingInterim();
    const text = session.accumulator.committedText;
    try {
      await session.stream.dispose();
    } finally {
      await session.recognizer.dispose();
      this.deps.status?.reportLiveDrops({ droppedMs: session.droppedMs, totalMs: session.totalMs });
    }
    return text;
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
      try {
        await session.stream.push(frame.samples, frame.sampleRate);
        for (const result of await session.stream.pullAvailable()) {
          session.accumulator.apply(result);
          changed = true;
        }
      } catch (error) {
        // The recording must survive a native error; a later frame or Stop may still produce text.
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
        // A throwing subscriber must not fault the loop and leave the engine open (B4).
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
function recordLevels(recorder: MicActivityRecorder | null, frame: Frame): void {
  if (recorder === null) return;
  const count = Math.round(frameMs(frame) / MIC_ACTIVITY_FRAME_MS);
  for (let i = 0; i < count; i += 1) {
    recorder.push(frame.levels?.[i] ?? SILENCE);
  }
}

const SILENCE: SourceLevels = { microphone: 0, output: 0 };
