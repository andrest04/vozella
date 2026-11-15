import type { AppSettings } from '../library/settings';

/*
 * This module imports types only, so `library/settings`, `summaries/provider` and `chat/user-prompts`
 * can read the table when they load without an import cycle. The helpers that need those modules
 * live in `api-providers`.
 */

/** Settings fields that hold a string per engine. */
type StringSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends string | null ? K : never;
}[keyof AppSettings];

/** The wire format an engine speaks. Gemini, Groq and the compatible kind reuse the OpenAI one. */
export type ApiProtocol = 'openai-chat' | 'anthropic-messages';

/**
 * What one row of the table declares. The saved `kind` (also the row's key) and the `providerId`
 * are stored on disk and sent over IPC, so they never change. `ApiEngine` below narrows both, and
 * the name key, to the values the table really holds.
 */
interface ApiEngineDeclaration {
  readonly kind: string;
  readonly providerId: string;
  readonly protocol: ApiProtocol;
  /** The product name in errors and status lines. */
  readonly displayName: string;
  /** Catalog key of the product name in the UI. */
  readonly nameKey: `Ui_Api${string}Name`;
  /** Null when the user supplies the endpoint (the compatible kind). */
  readonly defaultBaseUrl: string | null;
  /** The compatible kind also serves local servers (Ollama, LM Studio) that take no key. */
  readonly requiresKey: boolean;
  /** Suggestions for the model picker. The user may type any other id. */
  readonly models: readonly string[];
  /** The readable name of each suggested model, in the same order. Other ids show as typed. */
  readonly modelNames: Readonly<Record<string, string>>;
  /** Null when there is no sensible default (the compatible kind). */
  readonly defaultModel: string | null;
  readonly modelSetting: StringSettingKey;
  /** The saved model, trimmed, else the default, else an empty string. */
  readonly resolveModel: (settings: AppSettings) => string;
  /** The endpoint without a trailing slash; null when none is known. */
  readonly resolveBaseUrl: (settings: AppSettings) => string | null;
}

const trimmed = (value: string | null): string | null => {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
};

const modelResolver =
  (setting: StringSettingKey, fallback: string | null) =>
  (settings: AppSettings): string =>
    trimmed(settings[setting]) ?? fallback ?? '';

const fixedBaseUrl =
  (url: string): ApiEngineDeclaration['resolveBaseUrl'] =>
  () =>
    url;

/**
 * The single table of API key engines, in the order the app offers them. Add or change an engine
 * here: the kind and id lists, the type unions, the captions and the renderer's tables all derive
 * from it. What a new engine still needs by hand is listed in `api-provider-edit-points.test.ts`
 * (apps/desktop), which fails naming the engine and the missing piece.
 * Defaults and suggestions follow each provider's own model catalog (checked 2026-11-10):
 * developers.openai.com/api/docs/models, platform.claude.com/docs/en/about-claude/models/overview,
 * aistudio.google.com/docs/models. Groq lists its production chat models only (checked 2026-11-15):
 * console.groq.com/docs/models, with the endpoint from console.groq.com/docs/openai. Verify lists
 * the models a key can really use.
 */
export const API_ENGINES = {
  OpenAi: {
    kind: 'OpenAi',
    providerId: 'openai',
    protocol: 'openai-chat',
    displayName: 'OpenAI',
    nameKey: 'Ui_ApiOpenAiName',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'],
    modelNames: {
      'gpt-6-astra': 'GPT-6 Astra',
      'gpt-6.1-sol': 'GPT-6.1 Sol',
      'gpt-6.1-terra': 'GPT-6.1 Terra',
      'gpt-6-luna': 'GPT-6 Luna',
    },
    defaultModel: 'gpt-6-astra',
    modelSetting: 'selectedOpenAiModelId',
    resolveModel: modelResolver('selectedOpenAiModelId', 'gpt-6-astra'),
    resolveBaseUrl: fixedBaseUrl('https://api.openai.com/v1'),
  },
  Anthropic: {
    kind: 'Anthropic',
    providerId: 'anthropic',
    protocol: 'anthropic-messages',
    displayName: 'Anthropic',
    nameKey: 'Ui_ApiAnthropicName',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    models: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    modelNames: {
      'claude-opus-5-5': 'Claude Opus 5.5',
      'claude-fable-5-2': 'Claude Fable 5.2',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5',
      'claude-haiku-5-5': 'Claude Haiku 5.5',
    },
    defaultModel: 'claude-opus-5-5',
    modelSetting: 'selectedAnthropicModelId',
    resolveModel: modelResolver('selectedAnthropicModelId', 'claude-opus-5-5'),
    resolveBaseUrl: fixedBaseUrl('https://api.anthropic.com/v1'),
  },
  Gemini: {
    kind: 'Gemini',
    providerId: 'gemini',
    protocol: 'openai-chat',
    displayName: 'Google Gemini',
    nameKey: 'Ui_ApiGeminiName',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    modelNames: {
      'gemini-3.8-flash': 'Gemini 3.8 Flash',
      'gemini-3.6-flash': 'Gemini 3.6 Flash',
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
    },
    defaultModel: 'gemini-3.8-flash',
    modelSetting: 'selectedGeminiModelId',
    resolveModel: modelResolver('selectedGeminiModelId', 'gemini-3.8-flash'),
    resolveBaseUrl: fixedBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'),
  },
  Groq: {
    kind: 'Groq',
    providerId: 'groq',
    protocol: 'openai-chat',
    displayName: 'Groq',
    nameKey: 'Ui_ApiGroqName',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ],
    modelNames: {
      'llama-3.3-70b-versatile': 'Llama 3.3 70B Versatile',
      'llama-3.1-8b-instant': 'Llama 3.1 8B Instant',
      'openai/gpt-oss-120b': 'GPT-OSS 120B',
      'openai/gpt-oss-20b': 'GPT-OSS 20B',
    },
    defaultModel: 'llama-3.3-70b-versatile',
    modelSetting: 'selectedGroqModelId',
    resolveModel: modelResolver('selectedGroqModelId', 'llama-3.3-70b-versatile'),
    resolveBaseUrl: fixedBaseUrl('https://api.groq.com/openai/v1'),
  },
  OpenAiCompatible: {
    kind: 'OpenAiCompatible',
    providerId: 'openai-compatible',
    protocol: 'openai-chat',
    displayName: 'OpenAI-compatible',
    nameKey: 'Ui_ApiOpenAiCompatibleName',
    defaultBaseUrl: null,
    requiresKey: false,
    models: [],
    modelNames: {},
    defaultModel: null,
    modelSetting: 'selectedOpenAiCompatibleModelId',
    resolveModel: modelResolver('selectedOpenAiCompatibleModelId', null),
    resolveBaseUrl: (settings) =>
      trimmed(settings.openAiCompatibleBaseUrl)?.replace(/\/+$/, '') ?? null,
  },
} as const satisfies Readonly<Record<string, ApiEngineDeclaration>>;

/** The summary kinds backed by an HTTP API with the user's own key (BYOK). */
export type ApiProviderKind = keyof typeof API_ENGINES;
type DeclaredApiEngine = (typeof API_ENGINES)[ApiProviderKind];
/** The chat and summaries provider ids of the API key engines. */
export type ApiProviderId = DeclaredApiEngine['providerId'];

/**
 * What the app knows about one engine reached over HTTP with the user's own key (BYOK). The key
 * itself never lives here or in settings: it is in the `ApiKeyStore`.
 */
export interface ApiEngine extends ApiEngineDeclaration {
  readonly kind: ApiProviderKind;
  readonly providerId: ApiProviderId;
  readonly nameKey: DeclaredApiEngine['nameKey'];
}

export const API_ENGINE_LIST: readonly ApiEngine[] = Object.values(API_ENGINES);
export const API_PROVIDER_KINDS: readonly ApiProviderKind[] = API_ENGINE_LIST.map(
  (engine) => engine.kind,
);
export const API_PROVIDER_IDS: readonly ApiProviderId[] = API_ENGINE_LIST.map(
  (engine) => engine.providerId,
);
