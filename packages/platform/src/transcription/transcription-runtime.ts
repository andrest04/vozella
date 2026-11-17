import {
  AsrBackendStatus,
  CLOUD_TRANSCRIPTION_ENGINES,
  CloudRequestPacer,
  CloudSpeechEngineProvider,
  isFatalSpeechFailure,
  LiveTranscriptionService,
  LocalSpeechEngineProvider,
  NemoSpeechRecognizerFactory,
  resolveTranscriptionEngine,
  StreamingSpeechEngineProvider,
  TranscriptionEngineInstaller,
  TranscriptionService,
  type ApiKeyStore,
  type AppSettings,
  type AsrEngine,
  type AudioFrameReader,
  type CloudSpeechEngineProviderDeps,
  type CloudSpeechTimer,
  type CloudTranscriptionKind,
  type EngineModelStore,
  type HardwareProfile,
  type Logger,
  type MicActivityReader,
  type RecognizerSource,
  type RuntimeStore,
  type SettingsStore,
  type SpeechEngineProvider,
  type SpeechToTextClient,
  type StreamingSpeechProvider,
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
  /**
   * The streaming provider of a cloud engine whose live text is streamed, built with the settings
   * read when the live pass starts. Asked only for an engine the table marks `streaming`; null, or
   * leaving this out, makes that engine's live text arrive in pieces through `client`.
   */
  readonly streaming?: (
    kind: CloudTranscriptionKind,
    settings: AppSettings,
  ) => StreamingSpeechProvider | null;
  /**
   * The clock of the uploads: their pacing, backoff and rate limit waits. Tests replace it with
   * one that never sleeps; the app uses {@link systemSpeechTimer}.
   */
  readonly timer?: CloudSpeechTimer;
  /**
   * The wait of a streaming session's open timeout. It must really wait, so it is not `timer`: a
   * clock that resolves every wait at once would give a session up the moment it was asked for.
   * Tests drive it by hand; the app uses {@link systemSpeechTimer}.
   */
  readonly streamingTimer?: CloudSpeechTimer;
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

/** A live pass on a cloud engine ended early: which engine, and the failure the provider gave. */
export interface LiveTranscriptionFailure {
  readonly engine: CloudTranscriptionKind;
  readonly error: unknown;
}

/** Everything the transcription module builds from paths and an engine. */
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
   *
   * How the live text of a cloud engine arrives is a column of the engine table, and it picks the
   * provider here: `streaming` is one session per live pass with the recording uploaded for every
   * other pass; `pieces` uploads the live audio a few seconds at a time. Both are ready with the
   * key alone and report lost audio the same way.
   */
  async engine(): Promise<SpeechEngineProvider> {
    const { settings, cloud, logger } = this.options;
    if (settings === undefined || cloud === undefined) return this.local;
    const saved = await settings.load();
    const kind = resolveTranscriptionEngine(saved);
    if (kind === 'Local') return this.local;
    const uploads: CloudSpeechEngineProviderDeps = {
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
    };
    switch (CLOUD_TRANSCRIPTION_ENGINES[kind].liveText) {
      case 'pieces':
        return new CloudSpeechEngineProvider(uploads);
      case 'streaming':
        return new StreamingSpeechEngineProvider({
          ...uploads,
          streaming: () => cloud.streaming?.(kind, saved) ?? null,
          streamingTimer: cloud.streamingTimer ?? systemSpeechTimer,
        });
    }
  }
}
