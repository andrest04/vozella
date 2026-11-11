/** One request the fake received. Header names are lowercase. */
export interface FakeFetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON body, parsed; null for a request without one. */
  readonly body: unknown;
}

/** How the fake answers one request. */
export interface FakeHttpReply {
  /** Defaults to 200. */
  readonly status?: number;
  /** Body pieces sent in order, so a test can split an SSE line across two reads. */
  readonly chunks?: readonly string[];
  /** The request fails before any answer, the way `fetch` does when the host is unreachable. */
  readonly networkError?: boolean;
  /** No answer (or, after `chunks`, no end of body) until the request is aborted. */
  readonly hang?: boolean;
}

const abortError = (): Error => new DOMException('This operation was aborted', 'AbortError');

/**
 * Fake `fetch` for the HTTP adapters: records every call and answers from a script, honoring the
 * abort signal like the real one. No socket is ever opened.
 */
export class FakeFetch {
  readonly calls: FakeFetchCall[] = [];

  constructor(private readonly reply: FakeHttpReply | ((call: FakeFetchCall) => FakeHttpReply)) {}

  readonly fetch: typeof fetch = (input, init) => {
    const call: FakeFetchCall = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    };
    this.calls.push(call);
    const reply = typeof this.reply === 'function' ? this.reply(call) : this.reply;
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(abortError());
    if (reply.networkError) return Promise.reject(new TypeError('fetch failed'));
    if (reply.hang && reply.chunks === undefined) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(abortError());
        });
      });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of reply.chunks ?? []) controller.enqueue(encoder.encode(chunk));
        if (reply.hang) {
          signal?.addEventListener('abort', () => {
            controller.error(abortError());
          });
        } else {
          controller.close();
        }
      },
    });
    return Promise.resolve(new Response(body, { status: reply.status ?? 200 }));
  };
}
