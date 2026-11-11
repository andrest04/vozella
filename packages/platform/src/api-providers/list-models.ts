import {
  ApiProviderError,
  isChatModelId,
  type ApiEngine,
  type AppSettings,
  type CancelSignal,
} from '@vozella/core';
import { API_TIMEOUT_MS, apiJson, globalFetch, type ApiRequest } from './api-http';
import { anthropicHeaders } from './anthropic-messages-provider';
import { field } from './api-chat-provider';
import { openAiHeaders } from './openai-chat-provider';

export interface ListApiModelsOptions {
  readonly cancel?: CancelSignal;
  /** Defaults to `API_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** Gemini's OpenAI endpoint names models `models/<id>`; the chat call takes the bare id. */
const bareId = (id: string): string => id.replace(/^models\//, '');

function modelsRequest(engine: ApiEngine, baseUrl: string, key: string | null): ApiRequest {
  return engine.protocol === 'anthropic-messages'
    ? { url: `${baseUrl}/models?limit=1000`, method: 'GET', headers: anthropicHeaders(key) }
    : { url: `${baseUrl}/models`, method: 'GET', headers: openAiHeaders(key) };
}

/**
 * Whether a listed model belongs in the picker. A known provider's catalog also lists embedding,
 * image, audio and other non-chat models, and OpenAI marks models being retired with a
 * `shutdown_date`; both are left out. An OpenAI-compatible server's list is shown as it comes,
 * since its names follow no catalog.
 */
const pickable = (engine: ApiEngine, entry: unknown, id: string): boolean => {
  if (engine.kind === 'OpenAiCompatible') return true;
  const shutdown = field(entry, 'shutdown_date');
  return (shutdown === undefined || shutdown === null) && isChatModelId(id);
};

/**
 * The Settings "Verify" call: the chat model ids this key can use, sorted and without
 * duplicates. A failure maps like a prompt call (KeyInvalid, RateLimited, Network...), so the
 * same localized text explains it.
 */
export async function listApiModels(
  engine: ApiEngine,
  settings: AppSettings,
  key: string | null,
  fetchImpl: typeof fetch = globalFetch,
  options: ListApiModelsOptions = {},
): Promise<string[]> {
  const baseUrl = engine.resolveBaseUrl(settings);
  if (baseUrl === null) {
    throw new ApiProviderError(engine.displayName, 'Unknown', 'No base URL is set.');
  }
  const secret = key === null || key.trim() === '' ? null : key.trim();
  if (engine.requiresKey && secret === null) {
    throw new ApiProviderError(engine.displayName, 'KeyMissing');
  }
  const json = await apiJson(modelsRequest(engine, baseUrl, secret), {
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs ?? API_TIMEOUT_MS,
    ...(options.cancel ? { cancel: options.cancel } : {}),
    displayName: engine.displayName,
    secret,
  });
  const data = field(json, 'data');
  if (!Array.isArray(data)) {
    throw new ApiProviderError(engine.displayName, 'Unknown', 'The model list was not readable.');
  }
  const ids = data.flatMap((entry: unknown) => {
    const id = field(entry, 'id');
    if (typeof id !== 'string' || id.trim() === '') return [];
    const bare = bareId(id.trim());
    return pickable(engine, entry, bare) ? [bare] : [];
  });
  return [...new Set(ids)].sort();
}
