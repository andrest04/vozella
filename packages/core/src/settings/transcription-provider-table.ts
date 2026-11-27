import type { AppSettings } from '../library/settings';

/*
 * This module imports types only, like `api-engine-table`, so `api-keys` and the cloud
 * transcription table can read it without an import cycle.
 */

/**
 * How a stored key is checked without transcribing anything: a request of `method` to `path` under
 * the provider's endpoint, with no body, that carries the key in `header`, after `authScheme` and
 * a space when there is one (`Authorization: Token <key>`), else bare (`xi-api-key: <key>`). Any
 * 2xx answer means the key is accepted.
 */
export interface TranscriptionKeyCheck {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** The header name in lower case, as `fetch` sends it. */
  readonly header: string;
  readonly authScheme: string | null;
}

/** What one row declares. The saved `kind` (also the row's key) never changes. */
interface TranscriptionProviderDeclaration {
  readonly kind: string;
  /** The product name in errors and status lines. */
  readonly displayName: string;
  /** Catalog key of the product name in the UI. */
  readonly nameKey: `Ui_${string}Name`;
  /** The endpoint without a trailing slash. */
  readonly defaultBaseUrl: string;
  /** The same shape as an API engine's, so both serve a cloud transcription engine alike. */
  readonly resolveBaseUrl: (settings: AppSettings) => string;
  readonly keyCheck: TranscriptionKeyCheck;
}

/**
 * The providers that only transcribe, each with the user's own key (BYOK). They are not summary or
 * chat engines, so they are not rows of `API_ENGINES`: nothing that lists the API engines (the
 * summary and chat choices, the setup wizard, the API key group of Settings) ever shows them. What
 * they share with the API engines is the `ApiKeyStore`, which keeps one key per kind of either
 * table.
 *
 * A new transcription-only provider is one row here plus its row in `CLOUD_TRANSCRIPTION_ENGINES`.
 * What it still needs by hand is listed in `api-provider-edit-points.test.tsx` (apps/desktop).
 *
 * Deepgram (docs checked 2026-11-15): developers.deepgram.com/reference/management-api/projects/list
 * is the key check (`GET /v1/projects`, 401 for a key it does not know); the `Token` scheme is in
 * developers.deepgram.com/docs/authenticating.
 *
 * ElevenLabs (docs checked 2026-11-26): the key goes bare in `xi-api-key`
 * (elevenlabs.io/docs/api-reference/authentication). The key check asks for a single-use token of
 * the realtime transcription (`POST /v1/single-use-token/realtime_scribe`,
 * elevenlabs.io/docs/api-reference/tokens/create): the token is what opens a realtime Scribe
 * session, so a key that can mint one can stream, and minting transcribes nothing (an unused
 * token expires after 15 minutes). The docs do not say which scope of a restricted key the
 * endpoint requires, nor which status a refused key gets: unverified until tried with a real key.
 * `GET /v1/models` was the alternative; nothing says it needs the speech-to-text scope.
 */
export const TRANSCRIPTION_PROVIDERS = {
  Deepgram: {
    kind: 'Deepgram',
    displayName: 'Deepgram',
    nameKey: 'Ui_DeepgramName',
    defaultBaseUrl: 'https://api.deepgram.com/v1',
    resolveBaseUrl: () => 'https://api.deepgram.com/v1',
    keyCheck: { method: 'GET', path: '/projects', header: 'authorization', authScheme: 'Token' },
  },
  ElevenLabs: {
    kind: 'ElevenLabs',
    displayName: 'ElevenLabs',
    nameKey: 'Ui_ElevenLabsName',
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    resolveBaseUrl: () => 'https://api.elevenlabs.io/v1',
    keyCheck: {
      method: 'POST',
      path: '/single-use-token/realtime_scribe',
      header: 'xi-api-key',
      authScheme: null,
    },
  },
} as const satisfies Readonly<Record<string, TranscriptionProviderDeclaration>>;

/** The kinds that hold a key for transcription only. */
export type TranscriptionProviderKind = keyof typeof TRANSCRIPTION_PROVIDERS;
type DeclaredTranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[TranscriptionProviderKind];

export interface TranscriptionProvider extends TranscriptionProviderDeclaration {
  readonly kind: TranscriptionProviderKind;
  readonly nameKey: DeclaredTranscriptionProvider['nameKey'];
}

export const TRANSCRIPTION_PROVIDER_LIST: readonly TranscriptionProvider[] =
  Object.values(TRANSCRIPTION_PROVIDERS);
export const TRANSCRIPTION_PROVIDER_KINDS: readonly TranscriptionProviderKind[] =
  TRANSCRIPTION_PROVIDER_LIST.map((provider) => provider.kind);

export const isTranscriptionProviderKind = (
  kind: string | null | undefined,
): kind is TranscriptionProviderKind =>
  kind !== null && kind !== undefined && Object.hasOwn(TRANSCRIPTION_PROVIDERS, kind);
