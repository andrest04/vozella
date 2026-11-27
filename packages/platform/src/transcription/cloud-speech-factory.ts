import {
  ApiProviderError,
  CLOUD_TRANSCRIPTION_ENGINES,
  cloudTranscriptionProvider,
  isTranscriptionProviderKind,
  resolveCloudTranscriptionModel,
  TRANSCRIPTION_PROVIDERS,
  type ApiKeyStore,
  type AppSettings,
  type CloudSpeechTimer,
  type CloudTranscriptionKind,
  type SpeechToTextClient,
  type StreamingSpeechProvider,
} from '@vozella/core';
import { verifyTranscriptionProviderKey } from '../api-keys/transcription-provider-keys';
import { DeepgramLiveSpeechProvider } from './deepgram-live-speech-provider';
import { DeepgramSpeechToTextClient } from './deepgram-speech-to-text-client';
import { ElevenLabsLiveSpeechProvider } from './elevenlabs-live-speech-provider';
import { elevenLabsLiveModel } from './elevenlabs-scribe';
import { ElevenLabsSpeechToTextClient } from './elevenlabs-speech-to-text-client';
import type { LiveKeyCheckRequest } from './live-key-check';
import type { LiveSocketFactory } from './live-socket';
import { OpenAiSpeechToTextClient } from './openai-speech-to-text-client';

/**
 * How long the key check of a live session that never opened may take. Short, so the reason
 * reaches the user while the recording is young, and under the time the streaming engine gives a
 * session to open.
 */
export const LIVE_KEY_CHECK_TIMEOUT_MS = 8_000;

export interface CloudSpeechToTextDeps {
  readonly keys: Pick<ApiKeyStore, 'get'>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface CloudSpeechToTextChoice {
  readonly kind: CloudTranscriptionKind;
  readonly settings: AppSettings;
  /**
   * The saved transcription model. It is used only when this engine lists it: one setting holds
   * the model of whichever engine was selected when it was saved, so anything else (null, blank, a
   * model of another provider) is the default of this one.
   */
  readonly model?: string | null;
}

/** The endpoint of the provider, or the failure every adapter gives when none is set. */
function requireBaseUrl(choice: CloudSpeechToTextChoice): string {
  const provider = cloudTranscriptionProvider(choice.kind);
  const baseUrl = provider.resolveBaseUrl(choice.settings);
  if (baseUrl === null) {
    throw new ApiProviderError(provider.displayName, 'Unknown', 'No base URL is set.');
  }
  return baseUrl;
}

/**
 * The `SpeechToTextClient` of a cloud transcription engine, for audio that is already recorded:
 * the endpoint, name and key of its provider, the chosen model, and the adapter of its protocol.
 * The key is the one saved for that kind; a missing key fails with `KeyMissing` before any request.
 */
export function createCloudSpeechToTextClient(
  deps: CloudSpeechToTextDeps,
  choice: CloudSpeechToTextChoice,
): SpeechToTextClient {
  const options = {
    displayName: cloudTranscriptionProvider(choice.kind).displayName,
    baseUrl: requireBaseUrl(choice),
    model: resolveCloudTranscriptionModel(choice.kind, choice.model),
    apiKey: () => deps.keys.get(choice.kind),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  };
  switch (CLOUD_TRANSCRIPTION_ENGINES[choice.kind].protocol) {
    case 'openai-audio-transcriptions':
      return new OpenAiSpeechToTextClient(options);
    case 'deepgram-listen':
      return new DeepgramSpeechToTextClient(options);
    case 'elevenlabs-scribe':
      return new ElevenLabsSpeechToTextClient(options);
  }
}

export interface StreamingSpeechDeps {
  readonly keys: Pick<ApiKeyStore, 'get'>;
  /** The wait between KeepAlives; the app passes its real timer. */
  readonly timer: CloudSpeechTimer;
  /** The HTTP client of the key check. Tests replace it; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Tests replace it; production uses the runtime's `WebSocket`. */
  readonly socket?: LiveSocketFactory;
}

/**
 * The key check of a live session of `kind` that never opened: the same request Verify sends in
 * Settings for that provider, which says whether it takes the key. A kind with no key check of
 * its own (an API engine; none streams today) asks nothing, so the failure stays a connection one.
 */
function liveKeyCheck(
  deps: StreamingSpeechDeps,
  kind: CloudTranscriptionKind,
): LiveKeyCheckRequest {
  if (!isTranscriptionProviderKind(kind)) return () => Promise.resolve();
  const provider = TRANSCRIPTION_PROVIDERS[kind];
  return (key, cancel) =>
    verifyTranscriptionProviderKey(provider, key, deps.fetch, {
      cancel,
      timeoutMs: LIVE_KEY_CHECK_TIMEOUT_MS,
    });
}

/**
 * The `StreamingSpeechProvider` of a cloud transcription engine, for the live pass, or null when
 * its protocol has no streaming form (its live text arrives in pieces through the client above).
 * Whoever selects the engine of a pass puts the streaming speech engine in front of this for the
 * live pass and keeps `createCloudSpeechToTextClient` behind the cloud speech engine for the rest.
 */
export function createStreamingSpeechProvider(
  deps: StreamingSpeechDeps,
  choice: CloudSpeechToTextChoice,
): StreamingSpeechProvider | null {
  const { kind } = choice;
  const live = () => ({
    displayName: cloudTranscriptionProvider(kind).displayName,
    baseUrl: requireBaseUrl(choice),
    apiKey: () => deps.keys.get(kind),
    timer: deps.timer,
    checkKey: liveKeyCheck(deps, kind),
    ...(deps.socket ? { socket: deps.socket } : {}),
  });
  switch (CLOUD_TRANSCRIPTION_ENGINES[kind].protocol) {
    case 'openai-audio-transcriptions':
      return null;
    case 'deepgram-listen':
      return new DeepgramLiveSpeechProvider({
        ...live(),
        model: resolveCloudTranscriptionModel(kind, choice.model),
      });
    case 'elevenlabs-scribe':
      return new ElevenLabsLiveSpeechProvider({
        ...live(),
        // The setting names the batch model; the stream uses its realtime pair.
        model: elevenLabsLiveModel(resolveCloudTranscriptionModel(kind, choice.model)),
      });
  }
}
