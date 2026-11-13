import {
  isCliProvider,
  type ApiProviderKind,
  type AppSettings,
  type CliProviderKind,
} from '../library/settings';
import type { ProviderId } from '../summaries/provider';
import { CLI_ENGINES, cliEngineByProviderId, type CliProviderId } from './cli-providers';

/** Settings fields that hold a string per engine. */
type StringSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends string | null ? K : never;
}[keyof AppSettings];

/** The wire format an engine speaks. Gemini and the compatible kind reuse the OpenAI one. */
export type ApiProtocol = 'openai-chat' | 'anthropic-messages';

/** What is still missing before an API key engine can answer. */
export type ApiSetupGap = 'base-url-missing' | 'key-missing' | 'model-missing';

export type ApiProviderId = Extract<
  ProviderId,
  'openai' | 'anthropic' | 'gemini' | 'openai-compatible'
>;

/**
 * What the app knows about one engine reached over HTTP with the user's own key (BYOK). Like the
 * CLI table, the saved `kind` and the `providerId` are stored on disk and sent over IPC, so they
 * never change. The key itself never lives here or in settings: it is in the `ApiKeyStore`.
 */
export interface ApiEngine {
  readonly kind: ApiProviderKind;
  readonly providerId: ApiProviderId;
  readonly protocol: ApiProtocol;
  /** The product name in errors and status lines. */
  readonly displayName: string;
  /** Catalog key of the product name in the UI. */
  readonly nameKey:
    'Ui_ApiOpenAiName' | 'Ui_ApiAnthropicName' | 'Ui_ApiGeminiName' | 'Ui_ApiOpenAiCompatibleName';
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
  (url: string): ApiEngine['resolveBaseUrl'] =>
  () =>
    url;

/**
 * The single table of API key engines. Add or change an engine here.
 * Defaults and suggestions follow each provider's own model catalog (checked 2026-11-10):
 * developers.openai.com/api/docs/models, platform.claude.com/docs/en/about-claude/models/overview,
 * aistudio.google.com/docs/models. Verify lists the models a key can really use.
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
} as const satisfies Readonly<Record<ApiProviderKind, ApiEngine>>;

export const API_ENGINE_LIST: readonly ApiEngine[] = Object.values(API_ENGINES);

/**
 * Name fragments of the models a provider's model list returns that cannot answer a text chat:
 * embeddings, images, video, music, speech, realtime and live audio, moderation, translation and
 * specialist agents. Taken from the OpenAI and Gemini catalogs (checked 2026-11-10).
 */
const NON_CHAT_MODEL_FRAGMENTS = [
  'embed',
  'image',
  'imagen',
  'dall-e',
  'banana',
  'veo',
  'lyria',
  'omni',
  'tts',
  'whisper',
  'transcribe',
  'audio',
  'realtime',
  'live',
  'moderation',
  'translate',
  'cyber',
  'rosalind',
  'codex',
  'deep-research',
  'computer-use',
  'robotics',
  'antigravity',
  'aqa',
] as const;

/** Whether a listed model id is a text chat model (filters Verify's list for known catalogs). */
export const isChatModelId = (id: string): boolean => {
  const lower = id.toLowerCase();
  return !NON_CHAT_MODEL_FRAGMENTS.some((fragment) => lower.includes(fragment));
};

/**
 * The readable names of the ids in a model list that the engine knows. An id it does not know
 * (one Verify listed, or one the user typed) has no entry, so the picker shows the id itself.
 */
export const apiModelLabels = (
  engine: ApiEngine,
  ids: readonly string[],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    ids.flatMap((id) => {
      const name = Object.hasOwn(engine.modelNames, id) ? engine.modelNames[id] : undefined;
      return name === undefined ? [] : [[id, name] as const];
    }),
  );

/** The picker's list: the suggestions plus the saved model when it is not on it (B13). */
export const apiModelOptions = (engine: ApiEngine, model: string): readonly string[] =>
  model === '' || engine.models.includes(model) ? engine.models : [...engine.models, model];

/** The API engine behind a provider id; undefined for local, a CLI engine, or none. */
export const apiEngineByProviderId = (providerId: ProviderId | undefined): ApiEngine | undefined =>
  API_ENGINE_LIST.find((engine) => engine.providerId === providerId);

export const isApiEngine = (providerId: ProviderId | undefined): boolean =>
  apiEngineByProviderId(providerId) !== undefined;

/**
 * A remote engine (CLI or API) has a large context window: it gets the large chat budgets and
 * never map-reduces. Local, or an engine that does not say, gets the small ones.
 */
export const isRemoteEngine = (providerId: ProviderId | undefined): boolean =>
  cliEngineByProviderId(providerId) !== undefined || isApiEngine(providerId);

/** The saved summary-provider kind for a chat or summaries provider id. */
export const summaryKindOf = (
  providerId: ProviderId,
): 'Local' | CliProviderKind | ApiProviderKind =>
  cliEngineByProviderId(providerId)?.kind ?? apiEngineByProviderId(providerId)?.kind ?? 'Local';

/** The chat and summaries provider id of a saved summary-provider kind: `summaryKindOf` reversed. */
export const chatEngineOfKind = (
  kind: 'Local' | CliProviderKind | ApiProviderKind,
): 'local' | CliProviderId | ApiProviderId =>
  kind === 'Local'
    ? 'local'
    : isCliProvider(kind)
      ? CLI_ENGINES[kind].providerId
      : API_ENGINES[kind].providerId;

/**
 * The first thing an API key engine still needs, or null when it can answer: the endpoint, then
 * the key (only where the engine requires one), then a model id.
 */
export function apiSetupGap(
  engine: ApiEngine,
  settings: AppSettings,
  hasKey: boolean,
): ApiSetupGap | null {
  if (engine.resolveBaseUrl(settings) === null) return 'base-url-missing';
  if (engine.requiresKey && !hasKey) return 'key-missing';
  if (engine.resolveModel(settings) === '') return 'model-missing';
  return null;
}

/**
 * Catalog keys of the Settings answers about API keys that are not engine failures: the OS could
 * not encrypt the key, or the compatible engine has no address yet. `{0}` is the engine's name.
 */
export const API_KEY_SETTINGS_UI_KEYS = {
  storeUnavailable: 'Ui_ApiKeyStoreUnavailable',
  baseUrlMissing: 'Ui_ApiBaseUrlMissing',
} as const;

/** Rough token count for budgets on remote engines: about four characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
