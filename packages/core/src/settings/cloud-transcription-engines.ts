import type { AppSettings } from '../library/settings';
import { API_ENGINES, type ApiEngine, type ApiProviderKind } from './api-engine-table';

/**
 * How a provider takes audio. One value today: the OpenAI-compatible
 * `POST {baseUrl}/audio/transcriptions`. A provider with its own API adds a value here and its own
 * `SpeechToTextClient` adapter.
 */
export type CloudTranscriptionProtocol = 'openai-audio-transcriptions';

/** What a provider documents about how much it takes. Null where it documents no number. */
export interface CloudTranscriptionLimits {
  readonly requestsPerMinute: number | null;
  readonly audioSecondsPerHour: number | null;
  /** A shorter request is billed as this many seconds, so very short pieces cost more. */
  readonly minBilledSeconds: number | null;
}

/** What one row declares. `kind` is the row's key and an API engine kind. */
interface CloudTranscriptionEngineDeclaration {
  readonly kind: ApiProviderKind;
  readonly protocol: CloudTranscriptionProtocol;
  /** Suggestions for the model picker. The saved id may be any other. */
  readonly models: readonly string[];
  /** The readable name of each suggested model, in the same order. */
  readonly modelNames: Readonly<Record<string, string>>;
  readonly defaultModel: string;
  readonly limits: CloudTranscriptionLimits;
  /** The provider's own page where a signed-in user creates an API key. Always https. */
  readonly keyPageUrl: string;
}

/** Both providers refuse a larger upload (HTTP 413). */
export const CLOUD_TRANSCRIPTION_MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The API engines that can also transcribe, in the order the app offers them. A row adds nothing
 * about the endpoint or the key: both come from the API engine of the same kind in `API_ENGINES`
 * (one key per kind in the `ApiKeyStore`, never in settings). A new provider that speaks the
 * OpenAI-compatible endpoint is one row here, on top of its row in `API_ENGINES`.
 *
 * Models and limits follow each provider's own docs (checked 2026-11-15):
 * console.groq.com/docs/speech-to-text and console.groq.com/docs/rate-limits (developer plan: 20
 * requests per minute and 7,200 audio seconds per hour for both whisper models; at least 10 s
 * billed per request); platform.openai.com/docs/api-reference/audio/createTranscription.
 *
 * Key pages (checked 2026-11-15): console.groq.com/keys is GroqCloud's "API Keys" page, linked
 * from console.groq.com/docs/quickstart; platform.openai.com/api-keys is the "Create an API Key"
 * link of OpenAI's quickstart (developers.openai.com/api/docs/quickstart).
 */
export const CLOUD_TRANSCRIPTION_ENGINES = {
  Groq: {
    kind: 'Groq',
    protocol: 'openai-audio-transcriptions',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    modelNames: {
      'whisper-large-v3-turbo': 'Whisper Large v3 Turbo',
      'whisper-large-v3': 'Whisper Large v3',
    },
    defaultModel: 'whisper-large-v3-turbo',
    limits: { requestsPerMinute: 20, audioSecondsPerHour: 7200, minBilledSeconds: 10 },
    keyPageUrl: 'https://console.groq.com/keys',
  },
  OpenAi: {
    kind: 'OpenAi',
    protocol: 'openai-audio-transcriptions',
    // `whisper-1` is the only OpenAI model documented with word timestamps. OpenAI lists it as
    // deprecated, with shutdown on 2027-02-26: before that date this row needs its successor. The
    // saved model id is free text and a missing `words[]` falls back to segment times, so a user
    // can move earlier than a release.
    models: ['whisper-1'],
    modelNames: { 'whisper-1': 'Whisper' },
    defaultModel: 'whisper-1',
    limits: { requestsPerMinute: null, audioSecondsPerHour: null, minBilledSeconds: null },
    keyPageUrl: 'https://platform.openai.com/api-keys',
  },
} as const satisfies Partial<Record<ApiProviderKind, CloudTranscriptionEngineDeclaration>>;

/** The API engine kinds that can transcribe. */
export type CloudTranscriptionKind = keyof typeof CLOUD_TRANSCRIPTION_ENGINES;

export interface CloudTranscriptionEngine extends CloudTranscriptionEngineDeclaration {
  readonly kind: CloudTranscriptionKind;
}

export const CLOUD_TRANSCRIPTION_ENGINE_LIST: readonly CloudTranscriptionEngine[] = Object.values(
  CLOUD_TRANSCRIPTION_ENGINES,
);
export const CLOUD_TRANSCRIPTION_KINDS: readonly CloudTranscriptionKind[] =
  CLOUD_TRANSCRIPTION_ENGINE_LIST.map((engine) => engine.kind);

export const isCloudTranscriptionKind = (
  kind: string | null | undefined,
): kind is CloudTranscriptionKind =>
  kind !== null && kind !== undefined && Object.hasOwn(CLOUD_TRANSCRIPTION_ENGINES, kind);

/** The API engine that holds the name, endpoint and key of a cloud transcription engine. */
export const cloudTranscriptionApiEngine = (kind: CloudTranscriptionKind): ApiEngine =>
  API_ENGINES[kind];

/** The endpoint of the provider without a trailing slash, as its API engine resolves it. */
export const cloudTranscriptionBaseUrl = (
  kind: CloudTranscriptionKind,
  settings: AppSettings,
): string | null => cloudTranscriptionApiEngine(kind).resolveBaseUrl(settings);

/** The saved transcription model, trimmed, else the provider's default. */
export function resolveCloudTranscriptionModel(
  kind: CloudTranscriptionKind,
  saved: string | null | undefined,
): string {
  const model = saved?.trim() ?? '';
  return model === '' ? CLOUD_TRANSCRIPTION_ENGINES[kind].defaultModel : model;
}

/** The engine on this device (Nemotron): the default, and what a missing or unknown value means. */
export const LOCAL_TRANSCRIPTION_ENGINE = 'Local';

/** What can transcribe: the local engine or a cloud transcription engine. */
export type TranscriptionEngineKind = typeof LOCAL_TRANSCRIPTION_ENGINE | CloudTranscriptionKind;

/** The values of the `transcriptionEngine` setting, in the order the app offers them. */
export const TRANSCRIPTION_ENGINE_KINDS: readonly TranscriptionEngineKind[] = [
  LOCAL_TRANSCRIPTION_ENGINE,
  ...CLOUD_TRANSCRIPTION_KINDS,
];

/** The saved transcription engine: an exact cloud kind, else `Local`. */
export const resolveTranscriptionEngine = (
  settings: Pick<AppSettings, 'transcriptionEngine'>,
): TranscriptionEngineKind =>
  isCloudTranscriptionKind(settings.transcriptionEngine)
    ? settings.transcriptionEngine
    : LOCAL_TRANSCRIPTION_ENGINE;
