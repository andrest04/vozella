import type { AppSettings } from '../library/settings';
import { API_ENGINES, type ApiProviderKind } from './api-engine-table';
import {
  isTranscriptionProviderKind,
  TRANSCRIPTION_PROVIDERS,
  type TranscriptionProviderKind,
} from './transcription-provider-table';

/**
 * How a provider takes audio. `openai-audio-transcriptions` is the OpenAI-compatible
 * `POST {baseUrl}/audio/transcriptions`; `deepgram-listen` is Deepgram's `/listen` (a WebSocket
 * while recording, a POST for a finished file); `elevenlabs-scribe` is ElevenLabs Scribe (the
 * realtime WebSocket while recording, `POST {baseUrl}/speech-to-text` for a finished file). A
 * provider with its own API adds a value here and its own adapter.
 */
export type CloudTranscriptionProtocol =
  'openai-audio-transcriptions' | 'deepgram-listen' | 'elevenlabs-scribe';

/**
 * How the text of a live recording arrives: in `pieces` a few seconds after they were said (each
 * piece is one upload), or `streaming`, word by word as it is said.
 */
export type CloudLiveText = 'pieces' | 'streaming';

/** What a provider documents about how much it takes. Null where it documents no number. */
export interface CloudTranscriptionLimits {
  readonly requestsPerMinute: number | null;
  readonly audioSecondsPerHour: number | null;
  /** A shorter request is billed as this many seconds, so very short pieces cost more. */
  readonly minBilledSeconds: number | null;
}

/** What one row declares. `kind` is the row's key and the kind its key is stored under. */
interface CloudTranscriptionEngineDeclaration {
  readonly kind: ApiProviderKind | TranscriptionProviderKind;
  readonly protocol: CloudTranscriptionProtocol;
  readonly liveText: CloudLiveText;
  /** The models the app can ask this provider for. A saved id outside the list is not sent. */
  readonly models: readonly string[];
  /** The readable name of each suggested model, in the same order. */
  readonly modelNames: Readonly<Record<string, string>>;
  readonly defaultModel: string;
  readonly limits: CloudTranscriptionLimits;
  /** The provider's own page where a signed-in user creates an API key. Always https. */
  readonly keyPageUrl: string;
}

/** Groq and OpenAI refuse a larger upload to the OpenAI-compatible endpoint (HTTP 413). */
export const CLOUD_TRANSCRIPTION_MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The providers that can transcribe, in the order the app offers them. A row adds nothing about
 * the name, the endpoint or the key: they come from the row of the same kind in `API_ENGINES` (a
 * provider that also writes summaries) or in `TRANSCRIPTION_PROVIDERS` (one that only transcribes),
 * with one key per kind in the `ApiKeyStore`, never in settings. A new provider is one row here on
 * top of its row in one of those two tables.
 *
 * Models and limits follow each provider's own docs (checked 2026-11-15):
 * console.groq.com/docs/speech-to-text and console.groq.com/docs/rate-limits (developer plan: 20
 * requests per minute and 7,200 audio seconds per hour for both whisper models; at least 10 s
 * billed per request); platform.openai.com/docs/api-reference/audio/createTranscription.
 *
 * Key pages (checked 2026-11-15): console.groq.com/keys is GroqCloud's "API Keys" page, linked
 * from console.groq.com/docs/quickstart; platform.openai.com/api-keys is the "Create an API Key"
 * link of OpenAI's quickstart (developers.openai.com/api/docs/quickstart).
 *
 * Deepgram (checked 2026-11-15): `nova-3` on `/v1/listen`, live and prerecorded. Its docs give no
 * request or audio quota and no minimum billed length, so the limits are null. Keys are created in
 * the console (console.deepgram.com), which opens on the project that holds them.
 *
 * ElevenLabs (checked 2026-11-26): elevenlabs.io/docs/api-reference/speech-to-text/convert and
 * .../speech-to-text/v-1-speech-to-text-realtime. The setting names the batch model (`scribe_v2`,
 * `scribe_v3`); the live pass streams with its realtime pair (`scribe_v2_realtime`,
 * `scribe_v3_live`). `scribe_v2` is the default because the docs do not confirm `scribe_v3` as a
 * batch id yet. A file may be up to 15 h or 5 GB, far over the pieces the app uploads, and the docs
 * give no request or audio quota and no minimum billed length, so the limits are null. Keys are
 * created at elevenlabs.io/app/settings/api-keys.
 */
export const CLOUD_TRANSCRIPTION_ENGINES = {
  Groq: {
    kind: 'Groq',
    protocol: 'openai-audio-transcriptions',
    liveText: 'pieces',
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
    liveText: 'pieces',
    // `whisper-1` is the only OpenAI model documented with word timestamps. OpenAI lists it as
    // deprecated, with shutdown on 2027-02-26: before that date this row needs its successor (a
    // missing `words[]` already falls back to segment times). Only the ids listed here are sent.
    models: ['whisper-1'],
    modelNames: { 'whisper-1': 'Whisper' },
    defaultModel: 'whisper-1',
    limits: { requestsPerMinute: null, audioSecondsPerHour: null, minBilledSeconds: null },
    keyPageUrl: 'https://platform.openai.com/api-keys',
  },
  Deepgram: {
    kind: 'Deepgram',
    protocol: 'deepgram-listen',
    liveText: 'streaming',
    models: ['nova-3'],
    modelNames: { 'nova-3': 'Nova-3' },
    defaultModel: 'nova-3',
    limits: { requestsPerMinute: null, audioSecondsPerHour: null, minBilledSeconds: null },
    keyPageUrl: 'https://console.deepgram.com/',
  },
  ElevenLabs: {
    kind: 'ElevenLabs',
    protocol: 'elevenlabs-scribe',
    liveText: 'streaming',
    models: ['scribe_v2', 'scribe_v3'],
    modelNames: { scribe_v2: 'Scribe v2', scribe_v3: 'Scribe v3' },
    defaultModel: 'scribe_v2',
    limits: { requestsPerMinute: null, audioSecondsPerHour: null, minBilledSeconds: null },
    keyPageUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
} as const satisfies Partial<
  Record<ApiProviderKind | TranscriptionProviderKind, CloudTranscriptionEngineDeclaration>
>;

/** The kinds that can transcribe in the cloud. */
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

/**
 * What a cloud transcription engine takes from the provider behind it. An API engine and a
 * transcription-only provider both have this shape.
 */
export interface CloudTranscriptionProvider {
  readonly kind: CloudTranscriptionKind;
  /** The product name in errors and status lines. */
  readonly displayName: string;
  /** Catalog key of the product name in the UI. */
  readonly nameKey: string;
  /** Null when the user supplies the endpoint. */
  readonly defaultBaseUrl: string | null;
  /** The endpoint without a trailing slash; null when none is known. */
  readonly resolveBaseUrl: (settings: AppSettings) => string | null;
}

/**
 * The provider that holds the name, endpoint and key of a cloud transcription engine: its
 * transcription-only provider, else the API engine of the same kind.
 */
export const cloudTranscriptionProvider = (
  kind: CloudTranscriptionKind,
): CloudTranscriptionProvider =>
  isTranscriptionProviderKind(kind) ? TRANSCRIPTION_PROVIDERS[kind] : API_ENGINES[kind];

/**
 * The model an engine is asked for: the saved one, trimmed, when this engine lists it, else the
 * engine's default. One setting holds the model whatever engine is selected, so an id saved while
 * another engine was in use (or one no engine lists) is never sent to this one.
 */
export function resolveCloudTranscriptionModel(
  kind: CloudTranscriptionKind,
  saved: string | null | undefined,
): string {
  const engine: CloudTranscriptionEngineDeclaration = CLOUD_TRANSCRIPTION_ENGINES[kind];
  const model = saved?.trim() ?? '';
  return engine.models.includes(model) ? model : engine.defaultModel;
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
