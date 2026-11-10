import {
  ApiProviderError,
  apiFailureFromHttpStatus,
  CancelledError,
  throwIfCancelled,
  type CancelSignal,
} from '@vozella/core';

/** Five minutes without a byte, like the CLI timeout (spec 3.7). Callers may inject another. */
export const API_TIMEOUT_MS = 5 * 60 * 1000;

export interface ApiRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
}

export interface ApiCallOptions {
  readonly fetch: typeof fetch;
  /** Idle timeout: restarts with every received piece of the body. */
  readonly timeoutMs: number;
  readonly cancel?: CancelSignal;
  /** The engine name in errors. */
  readonly displayName: string;
  /** The key of this call, scrubbed from any server text kept in an error. */
  readonly secret: string | null;
}

/** The global `fetch`, called as a plain function (no `this` surprises). */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/** Server text kept in an error, with the key removed. */
export const scrubSecret = (text: string, secret: string | null): string =>
  secret === null || secret === '' ? text : text.split(secret).join('[redacted]');

/**
 * Sends one request and yields its body as decoded text. Every failure leaves as data: a cancel
 * as `CancelledError`, a non-2xx answer as the kind `apiFailureFromHttpStatus` picks, no byte
 * within the timeout as `TimedOut`, anything else on the wire as `Network`. The key is never part
 * of an error. Stopping the iteration aborts the request.
 */
export async function* apiBody(
  request: ApiRequest,
  options: ApiCallOptions,
): AsyncGenerator<string> {
  const { cancel, displayName } = options;
  if (cancel) throwIfCancelled(cancel);
  const controller = new AbortController();
  const state = { timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  };
  const stopCancel = cancel?.onCancel(() => {
    controller.abort();
  });
  try {
    arm();
    const response = await options.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = scrubSecret(await response.text().catch(() => ''), options.secret);
      throw new ApiProviderError(
        displayName,
        apiFailureFromHttpStatus(response.status, text),
        text === '' ? `HTTP ${String(response.status)}` : text,
      );
    }
    if (!response.body) return;
    const decoder = new TextDecoder();
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      arm();
      yield decoder.decode(part, { stream: true });
    }
    const tail = decoder.decode();
    if (tail !== '') yield tail;
  } catch (error) {
    if (cancel?.cancelled) throw new CancelledError();
    if (error instanceof ApiProviderError) throw error;
    throw new ApiProviderError(displayName, state.timedOut ? 'TimedOut' : 'Network', null, error);
  } finally {
    clearTimeout(timer);
    stopCancel?.();
    controller.abort();
  }
}

/** The whole body of a request parsed as JSON; an unreadable body is an `Unknown` failure. */
export async function apiJson(request: ApiRequest, options: ApiCallOptions): Promise<unknown> {
  let text = '';
  for await (const piece of apiBody(request, options)) text += piece;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiProviderError(options.displayName, 'Unknown', 'The answer was not valid JSON.');
  }
}
