import { ApiProviderError, type ApiFailureKind } from '@vozella/core';
import { scrubSecret, type ApiRequest } from './api-http';
import { ApiChatProvider, field, parseEventJson, type StreamStep } from './api-chat-provider';
import type { SseEvent } from './sse';

/** The Messages API version this adapter speaks. */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The Messages API requires an output cap. 8192 tokens holds a long meeting summary with its
 * action items; a longer answer is reported as truncated.
 */
export const ANTHROPIC_MAX_TOKENS = 8192;

export function anthropicHeaders(apiKey: string | null): Record<string, string> {
  return {
    'anthropic-version': ANTHROPIC_VERSION,
    ...(apiKey === null || apiKey === '' ? {} : { 'x-api-key': apiKey }),
  };
}

/** Stream `error` event types with their own failure kind; any other is Unknown. */
const ERROR_KINDS: Readonly<Record<string, ApiFailureKind>> = {
  authentication_error: 'KeyInvalid',
  permission_error: 'KeyInvalid',
  billing_error: 'QuotaExceeded',
  rate_limit_error: 'RateLimited',
  not_found_error: 'ModelNotFound',
  timeout_error: 'TimedOut',
};

/**
 * Anthropic's Messages protocol. No `temperature` is sent: newer models reject some sampling
 * combinations and the default suits summaries.
 */
export class AnthropicMessagesProvider extends ApiChatProvider {
  protected request(prompt: string): ApiRequest {
    return {
      url: `${this.baseUrl}/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...anthropicHeaders(this.apiKey) },
      body: {
        model: this.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      },
    };
  }

  protected read(event: SseEvent): StreamStep {
    const json = parseEventJson(event.data);
    if (json === null) return {};
    const type = typeof json.type === 'string' ? json.type : event.event;
    switch (type) {
      case 'content_block_delta': {
        const text = field(json, 'delta', 'text');
        return field(json, 'delta', 'type') === 'text_delta' && typeof text === 'string'
          ? { text }
          : {};
      }
      case 'message_delta':
        return field(json, 'delta', 'stop_reason') === 'max_tokens' ? { truncated: true } : {};
      case 'message_stop':
        return { done: true };
      case 'error': {
        const errorType = field(json, 'error', 'type');
        const message = field(json, 'error', 'message');
        const kind =
          (typeof errorType === 'string' ? ERROR_KINDS[errorType] : undefined) ?? 'Unknown';
        const detail = typeof message === 'string' ? scrubSecret(message, this.apiKey) : null;
        throw new ApiProviderError(this.displayName, kind, detail);
      }
      default:
        return {};
    }
  }
}
