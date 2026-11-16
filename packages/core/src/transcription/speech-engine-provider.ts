import type { ApiKeyStore } from '../api-keys/api-key-store';
import {
  LOCAL_TRANSCRIPTION_ENGINE,
  type CloudTranscriptionKind,
  type TranscriptionEngineKind,
} from '../settings/cloud-transcription-engines';
import {
  CloudSpeechEngine,
  type CloudSpeechEngineDeps,
  type CloudSpeechTimer,
} from './cloud-speech-engine';
import type {
  CreateRecognizerOptions,
  RecognizerSource,
  SessionRecognizer,
} from './recognizer-factory';
import type { SpeechToTextClient } from './speech-to-text';
import type { StreamingSpeechProvider } from './streaming-speech';
import { StreamingSpeechEngine } from './streaming-speech-engine';

/**
 * One way to transcribe: the engine on this device or a cloud provider. The transcription module
 * asks the selected one whether it can run and for the recognizer of a pass, so nothing else
 * branches on which engine is chosen.
 */
export interface SpeechEngineProvider extends RecognizerSource {
  readonly kind: TranscriptionEngineKind;
  /** True when a pass can start now: the engine is installed, or the provider's key is stored. */
  isReady(): Promise<boolean>;
}

export interface LocalSpeechEngineDeps {
  /** The model and a runtime are on disk. */
  readonly installer: { isReady(): boolean };
  readonly factory: RecognizerSource;
}

/** The Nemotron engine on this device. */
export class LocalSpeechEngineProvider implements SpeechEngineProvider {
  readonly kind = LOCAL_TRANSCRIPTION_ENGINE;

  constructor(private readonly deps: LocalSpeechEngineDeps) {}

  isReady(): Promise<boolean> {
    return Promise.resolve(this.deps.installer.isReady());
  }

  create(options?: CreateRecognizerOptions): Promise<SessionRecognizer> {
    return this.deps.factory.create(options);
  }
}

export interface CloudSpeechEngineProviderDeps extends Omit<CloudSpeechEngineDeps, 'client'> {
  readonly kind: CloudTranscriptionKind;
  readonly keys: Pick<ApiKeyStore, 'has'>;
  /** The client of this provider, built when a pass starts. */
  readonly client: () => SpeechToTextClient;
}

/**
 * A cloud transcription engine: ready when its key is stored, with nothing to install. Speaker
 * labels are always off, whatever the pass asks for: the endpoint returns no speakers.
 */
export class CloudSpeechEngineProvider implements SpeechEngineProvider {
  constructor(private readonly deps: CloudSpeechEngineProviderDeps) {}

  get kind(): CloudTranscriptionKind {
    return this.deps.kind;
  }

  isReady(): Promise<boolean> {
    return this.deps.keys.has(this.deps.kind);
  }

  async create(options: CreateRecognizerOptions = {}): Promise<SessionRecognizer> {
    const { timer, onLost, pacer } = this.deps;
    const engine = new CloudSpeechEngine({
      client: this.deps.client(),
      timer,
      ...(onLost ? { onLost } : {}),
      ...(pacer ? { pacer } : {}),
    });
    const recognizer = await engine.createRecognizer(
      { latency: options.latency ?? 'live' },
      options.cancel,
    );
    return { recognizer, diarization: false };
  }
}

export interface StreamingSpeechEngineProviderDeps extends CloudSpeechEngineProviderDeps {
  /**
   * The streaming provider of this kind, built when a live pass starts. Null when there is none
   * to build: the live pass then arrives in pieces through `client`, like any other cloud engine.
   */
  readonly streaming: () => StreamingSpeechProvider | null;
  /**
   * The wait of a session's open timeout. Apart from `timer`, which paces the uploads: this one
   * must really wait (a clock that resolves every wait at once would give a session up at once).
   */
  readonly streamingTimer: CloudSpeechTimer;
}

/**
 * A cloud transcription engine whose live text is streamed. The profile of the pass picks the way
 * the audio travels: a `live` pass opens one streaming session and hears the words as they are
 * said; an `offline` pass (the pass after Stop, an imported file, a re-transcription) uploads the
 * finished recording through the provider's `SpeechToTextClient`, with the pacing and retries of
 * the cloud speech engine. Both report lost audio to the same `onLost`. Ready when the key is
 * stored, like every cloud engine.
 */
export class StreamingSpeechEngineProvider implements SpeechEngineProvider {
  /** The same provider as an engine that uploads: the offline profile, and the fallback. */
  private readonly uploads: CloudSpeechEngineProvider;

  constructor(private readonly deps: StreamingSpeechEngineProviderDeps) {
    this.uploads = new CloudSpeechEngineProvider(deps);
  }

  get kind(): CloudTranscriptionKind {
    return this.deps.kind;
  }

  isReady(): Promise<boolean> {
    return this.uploads.isReady();
  }

  async create(options: CreateRecognizerOptions = {}): Promise<SessionRecognizer> {
    if ((options.latency ?? 'live') !== 'live') return this.uploads.create(options);
    const provider = this.deps.streaming();
    if (provider === null) return this.uploads.create(options);
    const { streamingTimer, onLost } = this.deps;
    const engine = new StreamingSpeechEngine({
      provider,
      timer: streamingTimer,
      ...(onLost ? { onLost } : {}),
    });
    const recognizer = await engine.createRecognizer({ latency: 'live' }, options.cancel);
    return { recognizer, diarization: false };
  }
}
