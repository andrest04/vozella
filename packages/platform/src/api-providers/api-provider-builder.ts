import { ApiProviderError, type ApiKeyStore, type ApiProviderBuilder } from '@vozella/core';
import { AnthropicMessagesProvider } from './anthropic-messages-provider';
import type { ApiChatProviderOptions } from './api-chat-provider';
import { OpenAiChatProvider } from './openai-chat-provider';

export interface ApiProviderBuilderDeps {
  /** Read once per built provider, so a key saved in Settings is used by the next call. */
  readonly keys: Pick<ApiKeyStore, 'get'>;
  /** Tests replace it; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * The real `ApiProviderBuilder`: picks the adapter by the engine's wire protocol and hands it the
 * endpoint, model and key read for this call. A required key that is not saved fails with
 * `KeyMissing` before any request.
 */
export function createApiProviderBuilder(deps: ApiProviderBuilderDeps): ApiProviderBuilder {
  return async (engine, settings) => {
    const baseUrl = engine.resolveBaseUrl(settings);
    if (baseUrl === null) {
      throw new ApiProviderError(engine.displayName, 'Unknown', 'No base URL is set.');
    }
    const saved = (await deps.keys.get(engine.kind))?.trim() ?? '';
    const apiKey = saved === '' ? null : saved;
    if (engine.requiresKey && apiKey === null) {
      throw new ApiProviderError(engine.displayName, 'KeyMissing');
    }
    const model = engine.resolveModel(settings);
    if (model === '') throw new ApiProviderError(engine.displayName, 'ModelNotFound');
    const options: ApiChatProviderOptions = {
      providerId: engine.providerId,
      displayName: engine.displayName,
      baseUrl,
      model,
      apiKey,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    };
    return engine.protocol === 'anthropic-messages'
      ? new AnthropicMessagesProvider(options)
      : new OpenAiChatProvider(options);
  };
}
