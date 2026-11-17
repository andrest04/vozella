import {
  isCliProvider,
  type ApiProviderKind,
  type AppSettings,
  type CliProviderKind,
} from '../library/settings';
import type { ProviderId } from '../summaries/provider';
import {
  API_ENGINES,
  API_ENGINE_LIST,
  type ApiEngine,
  type ApiProviderId,
} from './api-engine-table';
import { CLI_ENGINES, cliEngineByProviderId, type CliProviderId } from './cli-providers';

// The table itself lives in `api-engine-table`; `ApiProviderKind` and `API_PROVIDER_KINDS` are
// exported by `library/settings`, next to the other summary-provider kinds.
export {
  API_ENGINES,
  API_ENGINE_LIST,
  API_PROVIDER_IDS,
  type ApiEngine,
  type ApiProtocol,
  type ApiProviderId,
} from './api-engine-table';

/** What is still missing before an API key engine can answer. */
export type ApiSetupGap = 'base-url-missing' | 'key-missing' | 'model-missing';

/**
 * Name fragments of the models a provider's model list returns that cannot answer a text chat:
 * embeddings, images, video, music, speech, realtime and live audio, moderation, translation and
 * specialist agents. Taken from the OpenAI and Gemini catalogs (checked 2026-11-10), plus the
 * safety classifiers (`guard`) and the speech voices (`orpheus`) in Groq's (checked 2026-11-15).
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
  'guard',
  'orpheus',
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
