import { sanitizeSnippet } from './cli-failure';

/** Why an API key engine produced no answer. Each kind has its own localized sentence. */
export const API_FAILURE_KINDS = [
  'KeyMissing',
  'KeyInvalid',
  'QuotaExceeded',
  'RateLimited',
  'Network',
  'TimedOut',
  'EmptyOutput',
  'ModelNotFound',
  'Unknown',
] as const;
export type ApiFailureKind = (typeof API_FAILURE_KINDS)[number];

/**
 * Words of a 429 body that mean the account has no credit left, not that it is going too fast.
 * OpenAI answers billing exhaustion with the codes `insufficient_quota` and
 * `credit_balance_exhausted`; waiting does not fix either, so they are never `RateLimited`.
 */
const QUOTA_WORDS = /quota|insufficient|credit_balance/i;

/**
 * The wait a `Retry-After` header asks for, in milliseconds; null when the header is absent or is
 * not a count of seconds. Groq sends seconds, and only with a 429. The HTTP-date form is ignored:
 * no provider the app talks to sends it, and reading it would need a clock here.
 */
export function retryAfterMsFromHeader(value: string | null | undefined): number | null {
  const text = value?.trim() ?? '';
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Math.ceil(Number(text) * 1000);
}

/**
 * The failure kind for a non-2xx HTTP answer. Pure: the HTTP adapters read the status and body
 * and pass them here, so every engine maps the same way.
 */
export function apiFailureFromHttpStatus(status: number, bodyText: string): ApiFailureKind {
  switch (status) {
    case 401:
    case 403:
      return 'KeyInvalid';
    case 402:
      return 'QuotaExceeded';
    case 429:
      return QUOTA_WORDS.test(bodyText) ? 'QuotaExceeded' : 'RateLimited';
    case 404:
      return 'ModelNotFound';
    case 408:
    case 504:
      return 'TimedOut';
    default:
      return 'Unknown';
  }
}

/**
 * An API engine failure as data, like `CliToolError`: the kind and display name pick the
 * localized text; `detail` is a sanitized snippet kept only for Unknown. The key is never part
 * of the message (snippets are redacted).
 */
export class ApiProviderError extends Error {
  readonly kind: ApiFailureKind;
  readonly displayName: string;
  readonly detail: string | null;
  /**
   * How long the server asked the caller to wait before the next request, when it said so with a
   * rate limit; null otherwise. A caller that retries waits at least this long.
   */
  readonly retryAfterMs: number | null;

  constructor(
    displayName: string,
    kind: ApiFailureKind,
    detail: string | null = null,
    cause?: unknown,
    retryAfterMs: number | null = null,
  ) {
    const kept = kind === 'Unknown' ? sanitizeSnippet(detail) : null;
    super(
      `${displayName}: ${kind}${kept ? ` ${kept}` : ''}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ApiProviderError';
    this.kind = kind;
    this.displayName = displayName;
    this.detail = kept;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isApiProviderError = (error: unknown): error is ApiProviderError =>
  error instanceof ApiProviderError;
