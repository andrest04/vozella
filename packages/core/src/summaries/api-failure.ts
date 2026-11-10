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

const QUOTA_WORDS = /quota|insufficient/i;

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

  constructor(
    displayName: string,
    kind: ApiFailureKind,
    detail: string | null = null,
    cause?: unknown,
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
  }
}

export const isApiProviderError = (error: unknown): error is ApiProviderError =>
  error instanceof ApiProviderError;
