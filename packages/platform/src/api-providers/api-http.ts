import {
  ApiProviderError,
  apiFailureFromHttpStatus,
  CancelledError,
  retryAfterMsFromHeader,
  throwIfCancelled,
  type ApiFailureKind,
  type CancelSignal,
} from '@vozella/core';

/** Five minutes without a byte, like the CLI timeout. Callers may inject another. */
export const API_TIMEOUT_MS = 5 * 60 * 1000;

export interface ApiRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
  /**
   * Sent as multipart/form-data instead of `body` (file uploads). `fetch` writes the content type
   * with its boundary, so `headers` must not carry one.
   */
  readonly form?: FormData;
  /**
   * Sent as it is instead of `body` (an upload that is the whole request, such as a WAV file),
   * with `contentType` as its content type. Any content type in `headers` gives way to it.
   */
  readonly bytes?: { readonly data: Uint8Array<ArrayBuffer>; readonly contentType: string };
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
  /**
   * The failure kind of a non-2xx answer. Defaults to `apiFailureFromHttpStatus`; the
   * speech-to-text adapter reads a 429 more strictly.
   */
  readonly classify?: (status: number, bodyText: string) => ApiFailureKind;
}

/** The global `fetch`, called as a plain function (no `this` surprises). */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/** Server text kept in an error, with the key removed. */
export const scrubSecret = (text: string, secret: string | null): string =>
  secret === null || secret === '' ? text : text.split(secret).join('[redacted]');

type RequestParts = Pick<RequestInit, 'body'> & { headers: Readonly<Record<string, string>> };

const requestParts = (request: ApiRequest): RequestParts => {
  const { headers } = request;
  if (request.form !== undefined) return { headers, body: request.form };
  if (request.bytes !== undefined) {
    return {
      headers: { ...headers, 'content-type': request.bytes.contentType },
      body: request.bytes.data,
    };
  }
  return request.body === undefined ? { headers } : { headers, body: JSON.stringify(request.body) };
};

/**
 * Sends one request and yields its body as decoded text. Every failure leaves as data: a cancel
 * as `CancelledError`, a non-2xx answer as the kind `apiFailureFromHttpStatus` picks, no byte
 * within the timeout as `TimedOut`, anything else on the wire as `Network`. The key is never part
 * of an error. A rate limit carries the wait its `Retry-After` header asks for. Stopping the
 * iteration aborts the request. A JSON body, a multipart form and raw bytes take the same path.
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
      ...requestParts(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = scrubSecret(await response.text().catch(() => ''), options.secret);
      const kind = (options.classify ?? apiFailureFromHttpStatus)(response.status, text);
      throw new ApiProviderError(
        displayName,
        kind,
        text === '' ? `HTTP ${String(response.status)}` : text,
        undefined,
        // Only a rate limit is worth waiting out: exhausted billing answers 429 too.
        kind === 'RateLimited' ? retryAfterMsFromHeader(response.headers.get('retry-after')) : null,
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
