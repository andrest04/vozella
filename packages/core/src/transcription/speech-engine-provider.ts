import type { ApiKeyStore } from '../api-keys/api-key-store';
import {
  LOCAL_TRANSCRIPTION_ENGINE,
  type CloudTranscriptionKind,
  type TranscriptionEngineKind,
} from '../settings/cloud-transcription-engines';
import { CloudSpeechEngine, type CloudSpeechEngineDeps } from './cloud-speech-engine';
import type {
  CreateRecognizerOptions,
  RecognizerSource,
  SessionRecognizer,
} from './recognizer-factory';
import type { SpeechToTextClient } from './speech-to-text';

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
    const { timer, onLost } = this.deps;
    const engine = new CloudSpeechEngine({
      client: this.deps.client(),
      timer,
      ...(onLost ? { onLost } : {}),
    });
    const recognizer = await engine.createRecognizer(
      { latency: options.latency ?? 'live' },
      options.cancel,
    );
    return { recognizer, diarization: false };
  }
}
