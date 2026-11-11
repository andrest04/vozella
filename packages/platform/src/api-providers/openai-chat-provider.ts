import { ApiProviderError } from '@vozella/core';
import { scrubSecret, type ApiRequest } from './api-http';
import { ApiChatProvider, field, parseEventJson, type StreamStep } from './api-chat-provider';
import type { SseEvent } from './sse';

/** OpenAI-protocol headers: the bearer key only when there is one (local servers take none). */
export function openAiHeaders(apiKey: string | null): Record<string, string> {
  return apiKey === null || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
}

/**
 * The OpenAI chat-completions protocol: OpenAI, Gemini's OpenAI endpoint, and any compatible
 * server (OpenRouter, Groq, Ollama, LM Studio). No `temperature` or token cap is sent: reasoning
 * models reject a non-default temperature and the cap's field name differs between servers.
 */
export class OpenAiChatProvider extends ApiChatProvider {
  protected request(prompt: string): ApiRequest {
    return {
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...openAiHeaders(this.apiKey) },
      body: { model: this.model, stream: true, messages: [{ role: 'user', content: prompt }] },
    };
  }

  protected read(event: SseEvent): StreamStep {
    if (event.data.trim() === '[DONE]') return { done: true };
    const json = parseEventJson(event.data);
    if (json === null) return {};
    if (json.error !== undefined && json.error !== null) {
      const message = field(json.error, 'message');
      const detail = typeof message === 'string' ? message : JSON.stringify(json.error);
      throw new ApiProviderError(this.displayName, 'Unknown', scrubSecret(detail, this.apiKey));
    }
    const content = field(json, 'choices', 0, 'delta', 'content');
    const finish = field(json, 'choices', 0, 'finish_reason');
    return {
      ...(typeof content === 'string' ? { text: content } : {}),
      ...(finish === 'length' ? { truncated: true } : {}),
    };
  }
}
