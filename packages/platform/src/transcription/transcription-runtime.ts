import {
  ApiProviderError,
  AsrBackendStatus,
  CLOUD_TRANSCRIPTION_ENGINES,
  CloudRequestPacer,
  CloudSpeechEngineProvider,
  cloudTranscriptionProvider,
  isFatalSpeechFailure,
  LiveTranscriptionService,
  LocalSpeechEngineProvider,
  NemoSpeechRecognizerFactory,
  resolveTranscriptionEngine,
  TranscriptionEngineInstaller,
  TranscriptionService,
  type ApiKeyStore,
  type AppSettings,
  type AsrEngine,
  type AudioFrameReader,
  type CloudSpeechTimer,
  type CloudTranscriptionKind,
  type EngineModelStore,
  type HardwareProfile,
  type Logger,
  type MicActivityReader,
  type RecognizerSource,
  type RuntimeStore,
  type SessionRecognizer,
  type SettingsStore,
  type SpeechEngineProvider,
  type SpeechToTextClient,
} from '@vozella/core';
import { SidecarMicActivityReader } from './mic-activity-sidecar';
import { NemotronModelStore, type ModelStoreOptions } from './model-store';
import { NemoSpeechRuntimeManager, type RuntimeManagerOptions } from './runtime-manager';
import { WavFrameReader } from './wav-frame-reader';

/** The cloud engine's clock in the app: the system time and real waits that a cancel cuts short. */
export const systemSpeechTimer: CloudSpeechTimer = {
  nowMs: () => Date.now(),
  wait: (ms, cancel) =>
    new Promise<void>((resolve) => {
      if (cancel.cancelled) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const stop = cancel.onCancel(done);
    }),
};

/** What the cloud transcription engines need from the app. */
export interface CloudTranscriptionOptions {
  /** A cloud engine is ready when the key of its provider is stored. */
  readonly keys: Pick<ApiKeyStore, 'has'>;
  /** The client of a cloud engine, built with the settings read when the pass starts. */
  readonly client: (kind: CloudTranscriptionKind, settings: AppSettings) => SpeechToTextClient;
  /** Tests replace the clock; the app uses {@link systemSpeechTimer}. */
  readonly timer?: CloudSpeechTimer;
}

export interface TranscriptionRuntimeOptions {
  readonly transcriptionModelsDirectory: string;
  readonly nemoSpeechDirectory: string;
  /** The speech engine. In the app it is the proxy to the ASR utility process. */
  readonly engine: AsrEngine;
  readonly hardware: () => Promise<Pick<HardwareProfile, 'gpuName'>>;
  readonly logger: Logger;
  readonly audio?: AudioFrameReader;
  /** When the local user spoke in a recording; defaults to the sidecar next to the WAV. */
  readonly micActivity?: MicActivityReader;
  /** Test seams for the stores. */
  readonly models?: Partial<ModelStoreOptions>;
  readonly runtimes?: Partial<RuntimeManagerOptions>;
  /** Replaces the file based stores (the fake native build). */
  readonly stores?: { readonly models: EngineModelStore; readonly runtimes: RuntimeStore };
  /** Where the transcription engine setting is read. Without it the engine is always local. */
  readonly settings?: Pick<SettingsStore, 'load'>;
  /** The cloud transcription engines. Without it the engine is always local. */
  readonly cloud?: CloudTranscriptionOptions;
  /**
   * The wait of the live pass's stop deadline. Tests replace it; the app waits in real time,
   * whatever clock the uploads use.
   */
  readonly liveStopWait?: CloudSpeechTimer['wait'];
}

/**
 * TEMPORARY (odd/tasks/deepgram-streaming-transcription.md, T1): a cloud engine the settings can
 * select but that has no adapter yet. It is never ready, whether or not its key is stored, and a
 * pass on it fails with a plain reason instead of sending audio anywhere or falling back to another
 * engine. T3 replaces it with the real engine of the provider's protocol and removes this class,
 * the `unavailable` reason of the engine status and the `Ui_CloudEngineUnavailable` string.
 */
export class UnavailableSpeechEngineProvider implements SpeechEngineProvider {
  constructor(readonly kind: CloudTranscriptionKind) {}

  isReady(): Promise<boolean> {
    return Promise.resolve(false);
  }

  create(): Promise<SessionRecognizer> {
    return Promise.reject(
      new ApiProviderError(
        cloudTranscriptionProvider(this.kind).displayName,
        'Unknown',
        'This transcription engine is not available in this version yet.',
      ),
    );
  }
}

/** A live pass on a cloud engine ended early: which engine, and the failure the provider gave. */
export interface LiveTranscriptionFailure {
  readonly engine: CloudTranscriptionKind;
  readonly error: unknown;
}

/** Everything the transcription module builds from paths and an engine (spec 3.4 to 3.11). */
export class TranscriptionRuntime {
  private readonly liveFailureListeners = new Set<(failure: LiveTranscriptionFailure) => void>();
  /**
   * One pacer per provider for the life of the app: the provider counts the requests of a key,
   * so the live pass, the pass after Stop and a re-transcription take turns from the same one.
   */
  private readonly pacers = new Map<CloudTranscriptionKind, CloudRequestPacer>();
  readonly status = new AsrBackendStatus();
  readonly models: EngineModelStore;
  readonly runtimes: RuntimeStore;
  readonly installer: TranscriptionEngineInstaller;
  readonly factory: NemoSpeechRecognizerFactory;
  /** The engine on this device. */
  readonly local: SpeechEngineProvider;
  readonly offline: TranscriptionService;
  readonly live: LiveTranscriptionService;

  constructor(private readonly options: TranscriptionRuntimeOptions) {
    this.models =
      options.stores?.models ??
      new NemotronModelStore({
        directory: options.transcriptionModelsDirectory,
        ...options.models,
      });
    this.runtimes =
      options.stores?.runtimes ??
      new NemoSpeechRuntimeManager({
        root: options.nemoSpeechDirectory,
        ...options.runtimes,
      });
    this.installer = new TranscriptionEngineInstaller({
      models: this.models,
      runtimes: this.runtimes,
      hardware: options.hardware,
    });
    this.factory = new NemoSpeechRecognizerFactory({
      engine: options.engine,
      models: this.models,
      runtimes: this.runtimes,
      hardware: options.hardware,
      status: this.status,
    });
    this.local = new LocalSpeechEngineProvider({
      installer: this.installer,
      factory: this.factory,
    });
    // Each pass asks for its engine when it starts: a changed setting applies to the next pass,
    // never to one that is running.
    const selected: RecognizerSource = {
      create: async (create) => (await this.engine()).create(create),
    };
    this.offline = new TranscriptionService({
      factory: selected,
      audio: options.audio ?? new WavFrameReader(),
      micActivity: options.micActivity ?? new SidecarMicActivityReader(),
    });
    this.live = new LiveTranscriptionService({
      factory: selected,
      status: this.status,
      onError: (error) => {
        options.logger.warn('live transcription error', { error: String(error) });
      },
      // Stop never waits for a cloud engine longer than the deadline.
      stopWait: (ms, cancel) =>
        options.liveStopWait
          ? options.liveStopWait(ms, cancel)
          : systemSpeechTimer.wait(ms, cancel),
    });
  }

  private pacerOf(kind: CloudTranscriptionKind): CloudRequestPacer {
    let pacer = this.pacers.get(kind);
    if (pacer === undefined) {
      pacer = new CloudRequestPacer();
      this.pacers.set(kind, pacer);
    }
    return pacer;
  }

  /**
   * A live pass on a cloud engine stopped uploading because of a failure waiting cannot fix (the
   * key was refused, the account is out of credit, the model is unknown). The recording itself
   * goes on. A failed piece that only leaves a gap is not reported here. Returns the unsubscribe.
   */
  onLiveFailure(listener: (failure: LiveTranscriptionFailure) => void): () => void {
    this.liveFailureListeners.add(listener);
    return () => {
      this.liveFailureListeners.delete(listener);
    };
  }

  /**
   * The engine the settings select right now: the local one, or a cloud engine with the client
   * for these settings. Readiness, the Record gate and every pass go through it.
   */
  async engine(): Promise<SpeechEngineProvider> {
    const { settings, cloud, logger } = this.options;
    if (settings === undefined || cloud === undefined) return this.local;
    const saved = await settings.load();
    const kind = resolveTranscriptionEngine(saved);
    if (kind === 'Local') return this.local;
    // TEMPORARY (T1): only the OpenAI-compatible protocol has an adapter. See the class above.
    if (CLOUD_TRANSCRIPTION_ENGINES[kind].protocol !== 'openai-audio-transcriptions') {
      return new UnavailableSpeechEngineProvider(kind);
    }
    return new CloudSpeechEngineProvider({
      kind,
      keys: cloud.keys,
      client: () => cloud.client(kind, saved),
      timer: cloud.timer ?? systemSpeechTimer,
      pacer: this.pacerOf(kind),
      onLost: (error, lostMs) => {
        logger.warn('live transcription lost audio', {
          engine: kind,
          lostMs: Math.round(lostMs),
          cause:
            error === null ? 'buffer full' : error instanceof Error ? error.message : 'failure',
        });
        if (!isFatalSpeechFailure(error)) return;
        for (const listener of [...this.liveFailureListeners]) {
          try {
            listener({ engine: kind, error });
          } catch (thrown) {
            // A throwing listener must not reach the engine, which is still holding the take.
            logger.warn('live failure listener threw', { error: String(thrown) });
          }
        }
      },
    });
  }
}
