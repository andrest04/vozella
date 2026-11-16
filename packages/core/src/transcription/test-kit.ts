import type {
  AsrEngine,
  AsrRecognizer,
  AsrResult,
  AsrStream,
  RecognizerSettings,
  StreamOptions,
} from './asr-types';
import type { AudioFrameReader, AudioFrameSource, EngineModelStore, RuntimeStore } from './ports';
import type { AsrBackend } from './asr-types';
import type { CancelSignal } from '../cancel';
import type { CloudSpeechTimer } from './cloud-speech-engine';
import type { PinnedFile } from './engine-catalog';
import type { SpeechToTextClient, SpeechToTextRequest, SpeechToTextResult } from './speech-to-text';
import type {
  StreamingSpeechListener,
  StreamingSpeechOptions,
  StreamingSpeechProvider,
  StreamingSpeechSession,
} from './streaming-speech';

/** Doubles for the engine and its stores. Used by the tests of core, platform and the desktop app. */

export interface FakeStreamScript {
  /** Results returned by `pullAvailable` after each push, in order; later pushes get none. */
  readonly afterPush?: readonly (readonly AsrResult[])[];
  /** Makes `push` wait until this promise settles (a slow backend). */
  readonly pushGate?: () => Promise<void>;
  readonly pushError?: Error;
}

export class FakeAsrStream implements AsrStream {
  pushes: { samples: Float32Array; sampleRate: number }[] = [];
  disposed = 0;
  finishCalled = false;
  private index = 0;

  constructor(
    readonly options: StreamOptions,
    private readonly script: FakeStreamScript,
  ) {}

  async push(samples: Float32Array, sampleRate: number): Promise<void> {
    await this.script.pushGate?.();
    if (this.script.pushError) throw this.script.pushError;
    this.pushes.push({ samples, sampleRate });
  }

  pullAvailable(): Promise<readonly AsrResult[]> {
    const results = this.script.afterPush?.[this.index] ?? [];
    this.index += 1;
    return Promise.resolve(results);
  }

  dispose(): Promise<void> {
    this.disposed += 1;
    return Promise.resolve();
  }
}

export class FakeAsrRecognizer implements AsrRecognizer {
  streams: FakeAsrStream[] = [];
  disposed = 0;

  constructor(
    readonly settings: RecognizerSettings,
    private readonly script: FakeStreamScript,
    private readonly startError: Error | null = null,
  ) {}

  startStream(options: StreamOptions): Promise<AsrStream> {
    if (this.startError) return Promise.reject(this.startError);
    const stream = new FakeAsrStream(options, this.script);
    this.streams.push(stream);
    return Promise.resolve(stream);
  }

  dispose(): Promise<void> {
    this.disposed += 1;
    return Promise.resolve();
  }
}

export class FakeAsrEngine implements AsrEngine {
  recognizers: FakeAsrRecognizer[] = [];
  /** Backends (by gpu id) whose creation fails with this message. */
  failGpu = new Map<number, string>();
  script: FakeStreamScript = {};
  startError: Error | null = null;

  createRecognizer(settings: RecognizerSettings): Promise<AsrRecognizer> {
    const failure = this.failGpu.get(settings.gpu);
    if (failure !== undefined) return Promise.reject(new Error(failure));
    const recognizer = new FakeAsrRecognizer(settings, this.script, this.startError);
    this.recognizers.push(recognizer);
    return Promise.resolve(recognizer);
  }
}

export class FakeRuntimeStore implements RuntimeStore {
  ready = new Set<AsrBackend>();
  downloads: AsrBackend[] = [];
  deleteError: Error | null = null;
  deleted = 0;

  isReady(backend: AsrBackend): boolean {
    return this.ready.has(backend);
  }
  binDirectory(backend: AsrBackend): string {
    if (!this.ready.has(backend))
      throw new Error(`The NeMo-Speech ${backend} runtime is not installed.`);
    return `C:/runtime/${backend}/bin`;
  }
  download(backend: AsrBackend, onProgress: (percent: number) => void): Promise<void> {
    this.downloads.push(backend);
    onProgress(50);
    this.ready.add(backend);
    return Promise.resolve();
  }
  delete(): Promise<void> {
    if (this.deleteError) return Promise.reject(this.deleteError);
    this.deleted += 1;
    this.ready.clear();
    return Promise.resolve();
  }
}

export class FakeModelStore implements EngineModelStore {
  model = false;
  diarization = false;
  downloads: string[] = [];
  deleteModelError: Error | null = null;
  deleteDiarError: Error | null = null;

  modelPath = (): string => 'C:/models/asr.gguf';
  diarizationModelPath = (): string => 'C:/models/diar.gguf';
  isModelDownloaded = (): boolean => this.model;
  isDiarizationModelDownloaded = (): boolean => this.diarization;

  download(
    file: PinnedFile,
    onProgress: (percent: number) => void,
    _cancel?: CancelSignal,
  ): Promise<void> {
    this.downloads.push(file.fileName);
    onProgress(100);
    if (file.fileName.startsWith('diar')) this.diarization = true;
    else this.model = true;
    return Promise.resolve();
  }
  deleteModel(): Promise<void> {
    if (this.deleteModelError) return Promise.reject(this.deleteModelError);
    this.model = false;
    return Promise.resolve();
  }
  deleteDiarizationModel(): Promise<void> {
    if (this.deleteDiarError) return Promise.reject(this.deleteDiarError);
    this.diarization = false;
    return Promise.resolve();
  }
}

/** A WAV made of samples already in memory. */
export class FakeAudioReader implements AudioFrameReader {
  opened: string[] = [];
  closed = 0;

  constructor(
    private readonly samples: Float32Array,
    private readonly sampleRate = 16_000,
    private readonly channels = 1,
    private readonly failOpen: Error | null = null,
  ) {}

  open(path: string): AudioFrameSource {
    this.opened.push(path);
    if (this.failOpen) throw this.failOpen;
    let offset = 0;
    const closeCount = (): void => {
      this.closed += 1;
    };
    const samples = this.samples;
    return {
      sampleRate: this.sampleRate,
      channels: this.channels,
      durationMs: (samples.length / this.channels / this.sampleRate) * 1000,
      read(buffer: Float32Array): number {
        const count = Math.min(buffer.length, samples.length - offset);
        buffer.set(samples.subarray(offset, offset + count));
        offset += count;
        return count;
      },
      close(): void {
        closeCount();
      },
    };
  }
}

/**
 * A speech-to-text client that answers `piece<n>` with one word from 100 to 200 ms of the piece,
 * unless told otherwise. It records what it was asked and how many calls ran at once.
 */
export class ScriptedSpeechToTextClient implements SpeechToTextClient {
  readonly requests: SpeechToTextRequest[] = [];
  readonly cancels: CancelSignal[] = [];
  /** Consumed one per call: the error that call throws. With none left, calls answer. */
  errors: Error[] = [];
  inFlight = 0;
  maxInFlight = 0;
  answer: (call: number, request: SpeechToTextRequest) => SpeechToTextResult = (call, request) => ({
    text: `piece${String(call)}`,
    words: [{ text: `piece${String(call)}`, startMs: 100, endMs: 200 }],
    durationMs: (request.samples.length * 1000) / request.sampleRate,
  });
  /** When set, every call waits for `release()`. */
  private gates: (() => void)[] | null = null;

  /** Makes every call wait until `release()` lets the oldest one go (a slow upload). */
  hold(): void {
    this.gates = [];
  }

  release(): void {
    this.gates?.shift()?.();
  }

  async transcribe(
    request: SpeechToTextRequest,
    cancel: CancelSignal,
  ): Promise<SpeechToTextResult> {
    const call = this.requests.length;
    this.requests.push(request);
    this.cancels.push(cancel);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gates !== null) {
        const gates = this.gates;
        await new Promise<void>((resolve) => {
          gates.push(resolve);
          cancel.onCancel(resolve);
        });
        if (cancel.cancelled) throw new Error('aborted');
      } else {
        await Promise.resolve();
      }
      const error = this.errors.shift();
      if (error !== undefined) throw error;
      return this.answer(call, request);
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** The cloud engine's clock for tests: it moves only when the engine waits, and never sleeps. */
export class FakeSpeechTimer implements CloudSpeechTimer {
  now = 0;
  readonly waits: number[] = [];
  nowMs = (): number => this.now;
  wait = (waitMs: number): Promise<void> => {
    this.waits.push(waitMs);
    this.now += waitMs;
    return Promise.resolve();
  };
}

/**
 * The cloud engine's clock for tests of long waits: time moves only when the test says so, and a
 * wait ends when the clock reaches it or its cancel fires, as the app's timer does.
 */
export class ManualSpeechTimer implements CloudSpeechTimer {
  now = 0;
  readonly waits: number[] = [];
  private sleepers: { readonly at: number; readonly wake: () => void }[] = [];

  nowMs = (): number => this.now;

  wait = (waitMs: number, cancel: CancelSignal): Promise<void> => {
    this.waits.push(waitMs);
    if (cancel.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const sleeper = { at: this.now + waitMs, wake: resolve };
      this.sleepers.push(sleeper);
      cancel.onCancel(() => {
        this.sleepers = this.sleepers.filter((other) => other !== sleeper);
        resolve();
      });
    });
  };

  /** Moves the clock forward, waking each wait at its time and letting the woken code run. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await ManualSpeechTimer.settle();
    for (;;) {
      const next = this.sleepers.reduce<number | null>(
        (earliest, sleeper) => (earliest === null || sleeper.at < earliest ? sleeper.at : earliest),
        null,
      );
      if (next === null || next > end) break;
      this.now = Math.max(this.now, next);
      const due = this.sleepers.filter((sleeper) => sleeper.at <= this.now);
      this.sleepers = this.sleepers.filter((sleeper) => sleeper.at > this.now);
      for (const sleeper of due) sleeper.wake();
      await ManualSpeechTimer.settle();
    }
    this.now = end;
    await ManualSpeechTimer.settle();
  }

  private static async settle(): Promise<void> {
    for (let i = 0; i < 80; i += 1) await Promise.resolve();
  }
}

/** One session of the scripted streaming provider: what it was sent, and its listener to drive. */
export class ScriptedStreamingSpeechSession implements StreamingSpeechSession {
  readonly sent: Float32Array[] = [];
  finished = false;
  closed = false;

  constructor(
    readonly options: StreamingSpeechOptions,
    readonly listener: StreamingSpeechListener,
  ) {}

  get sentSamples(): number {
    return this.sent.reduce((total, samples) => total + samples.length, 0);
  }

  send(samples: Float32Array): void {
    this.sent.push(samples);
  }

  finish(): void {
    this.finished = true;
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * A streaming provider that does nothing on its own: the test opens each session, gives its
 * results and closes it through `sessions[n].listener`, so every order of events can be written.
 */
export class ScriptedStreamingSpeechProvider implements StreamingSpeechProvider {
  readonly displayName = 'Scripted';
  readonly sessions: ScriptedStreamingSpeechSession[] = [];
  /** When set, `open` throws it (a provider that breaks its contract). */
  openError: Error | null = null;

  open(options: StreamingSpeechOptions, listener: StreamingSpeechListener): StreamingSpeechSession {
    if (this.openError !== null) throw this.openError;
    const session = new ScriptedStreamingSpeechSession(options, listener);
    this.sessions.push(session);
    return session;
  }
}
