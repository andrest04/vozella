import {
  AsrBackendStatus,
  CloudSpeechEngineProvider,
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
}

/** Everything the transcription module builds from paths and an engine (spec 3.4 to 3.11). */
export class TranscriptionRuntime {
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
    });
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
    return new CloudSpeechEngineProvider({
      kind,
      keys: cloud.keys,
      client: () => cloud.client(kind, saved),
      timer: cloud.timer ?? systemSpeechTimer,
      onLost: (error, lostMs) => {
        logger.warn('live transcription lost audio', {
          engine: kind,
          lostMs: Math.round(lostMs),
          cause:
            error === null ? 'buffer full' : error instanceof Error ? error.message : 'failure',
        });
      },
    });
  }
}
