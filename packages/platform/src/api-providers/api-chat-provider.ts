import {
  ApiProviderError,
  buildSummaryPrompt,
  CancelledError,
  summaryResultFromResponse,
  type CancelSignal,
  type PromptCallOptions,
  type ProviderId,
  type SummarizeRequest,
  type SummaryProvider,
  type SummaryResult,
} from '@vozella/core';
import { API_TIMEOUT_MS, apiBody, globalFetch, type ApiRequest } from './api-http';
import { createSseParser, type SseEvent } from './sse';

export interface ApiChatProviderOptions {
  readonly providerId: ProviderId;
  readonly displayName: string;
  /** The endpoint without a trailing slash. */
  readonly baseUrl: string;
  readonly model: string;
  /** Null for the compatible kind without a key (Ollama, LM Studio). */
  readonly apiKey: string | null;
  /** Tests replace it; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Idle timeout of one request. Defaults to `API_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** What one stream event means to the provider. */
export interface StreamStep {
  readonly text?: string;
  /** The output cap stopped the answer. */
  readonly truncated?: boolean;
  /** The answer is complete; later bytes are ignored. */
  readonly done?: boolean;
}

/**
 * The base of the HTTP providers: one streaming request per prompt, whole (remote engines never
 * map-reduce). A protocol supplies only its request and how it reads one SSE event (Template
 * Method), so cancel, timeouts, error mapping and empty output behave the same for every engine.
 */
export abstract class ApiChatProvider implements SummaryProvider {
  readonly id: ProviderId;
  protected readonly displayName: string;
  protected readonly baseUrl: string;
  protected readonly model: string;
  protected readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiChatProviderOptions) {
    this.id = options.providerId;
    this.displayName = options.displayName;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalFetch;
    this.timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  }

  /** The request that streams the answer to `prompt`. */
  protected abstract request(prompt: string): ApiRequest;

  /** Reads one SSE event. Throws an `ApiProviderError` for an error event. */
  protected abstract read(event: SseEvent): StreamStep;

  async summarize(request: SummarizeRequest, cancel: CancelSignal): Promise<SummaryResult> {
    const raw = await this.completePrompt(buildSummaryPrompt(request), cancel);
    return summaryResultFromResponse(this.id, raw, request);
  }

  async completePrompt(
    prompt: string,
    cancel: CancelSignal,
    options?: PromptCallOptions,
  ): Promise<string> {
    let text = '';
    for await (const piece of this.streamPrompt(prompt, cancel, options)) text += piece;
    return text.trim();
  }

  async *streamPrompt(
    prompt: string,
    cancel: CancelSignal,
    options?: PromptCallOptions,
  ): AsyncGenerator<string> {
    const parser = createSseParser();
    const state = { truncated: false, spoke: false, done: false };
    const take = (events: SseEvent[]): string[] => {
      const pieces: string[] = [];
      for (const event of events) {
        if (state.done) break;
        const step = this.read(event);
        if (step.truncated === true) state.truncated = true;
        if (step.text !== undefined && step.text !== '') {
          if (step.text.trim() !== '') state.spoke = true;
          pieces.push(step.text);
        }
        if (step.done === true) state.done = true;
      }
      return pieces;
    };
    const body = apiBody(this.request(prompt), {
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      cancel,
      displayName: this.displayName,
      secret: this.apiKey,
    });
    for await (const text of body) {
      yield* take(parser.push(text));
      if (state.done) break;
    }
    if (!state.done) yield* take(parser.flush());
    if (cancel.cancelled) throw new CancelledError();
    if (!state.spoke) throw new ApiProviderError(this.displayName, 'EmptyOutput');
    options?.onOutcome?.({ truncated: state.truncated });
  }
}

/** Reads a JSON event payload; null for anything that is not a JSON object. */
export function parseEventJson(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A nested field of an untyped JSON object, or undefined. */
export function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
