import { describe, expect, it } from 'vitest';
import { createLookup, type Catalogs } from '../i18n/translator';
import {
  API_FAILURE_KINDS,
  ApiProviderError,
  apiFailureFromHttpStatus,
  isApiProviderError,
  retryAfterMsFromHeader,
  speechFailureFromHttpStatus,
} from './api-failure';
import {
  API_FAILURE_UI_KEYS,
  formatFailure,
  SUMMARY_FAILURE_CATALOG_KEYS,
} from './cli-failure-messages';

describe('apiFailureFromHttpStatus', () => {
  it.each([
    [401, '', 'KeyInvalid'],
    [403, 'forbidden', 'KeyInvalid'],
    [402, '', 'QuotaExceeded'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'QuotaExceeded'],
    [429, 'You exceeded your current QUOTA', 'QuotaExceeded'],
    [429, 'Rate limit reached for requests', 'RateLimited'],
    // OpenAI billing exhaustion is a 429 too; it must never read as a rate limit to retry.
    [429, '{"error":{"code":"credit_balance_exhausted"}}', 'QuotaExceeded'],
    [404, 'model not found', 'ModelNotFound'],
    // No kind for "file too large": it stays Unknown and keeps the server text.
    [413, 'Request Entity Too Large', 'Unknown'],
    [408, '', 'TimedOut'],
    [504, '', 'TimedOut'],
    [500, 'oops', 'Unknown'],
    [400, 'bad request', 'Unknown'],
  ] as const)('%i %j is %s', (status, body, kind) => {
    expect(apiFailureFromHttpStatus(status, body)).toBe(kind);
  });
});

describe('speechFailureFromHttpStatus', () => {
  it.each([
    [429, '{"error":{"code":"insufficient_quota"}}', 'QuotaExceeded'],
    [429, '{"error":{"type":"insufficient_quota","message":"x"}}', 'QuotaExceeded'],
    [429, '{"error":{"code":"credit_balance_exhausted"}}', 'QuotaExceeded'],
    [429, '{"code":"insufficient_quota"}', 'QuotaExceeded'],
    // A message that only mentions a quota is a limit that lifts: it must stay retryable.
    [429, '{"error":{"message":"audio seconds quota exceeded","type":"seconds"}}', 'RateLimited'],
    [
      429,
      '{"error":{"message":"insufficient_quota is not this","code":"rate_limit_exceeded"}}',
      'RateLimited',
    ],
    [429, '{"error":{"code":"insufficient_quota_soon"}}', 'RateLimited'],
    [429, 'You exceeded your current QUOTA', 'RateLimited'],
    [429, '', 'RateLimited'],
    // Every other status maps as it does for the chat engines.
    [401, '', 'KeyInvalid'],
    [402, '', 'QuotaExceeded'],
    [404, 'model not found', 'ModelNotFound'],
    [413, 'Request Entity Too Large', 'Unknown'],
    [504, '', 'TimedOut'],
  ] as const)('%i %j is %s', (status, body, kind) => {
    expect(speechFailureFromHttpStatus(status, body)).toBe(kind);
  });
});

describe('ApiProviderError', () => {
  it('keeps the kind and display name, and a detail only for Unknown', () => {
    const invalid = new ApiProviderError('OpenAI', 'KeyInvalid', 'should be dropped');
    expect(invalid.kind).toBe('KeyInvalid');
    expect(invalid.displayName).toBe('OpenAI');
    expect(invalid.detail).toBeNull();
    expect(isApiProviderError(invalid)).toBe(true);
    expect(isApiProviderError(new Error('x'))).toBe(false);
    const unknown = new ApiProviderError('OpenAI', 'Unknown', 'Bearer sk-abcdefghijklmnop failed');
    expect(unknown.detail).not.toContain('sk-abcdefghijklmnop');
    expect(unknown.detail).toContain('[redacted]');
  });

  it('carries the wait the server asked for, null when it asked for none', () => {
    expect(new ApiProviderError('Groq', 'RateLimited').retryAfterMs).toBeNull();
    expect(new ApiProviderError('Groq', 'RateLimited', null, undefined, 7000).retryAfterMs).toBe(
      7000,
    );
  });
});

describe('retryAfterMsFromHeader', () => {
  it.each([
    ['7', 7000],
    [' 2 ', 2000],
    ['0', 0],
    ['1.5', 1500],
  ])('reads %j seconds as %i ms', (header, ms) => {
    expect(retryAfterMsFromHeader(header)).toBe(ms);
  });

  it.each([null, '', 'soon', '-3', 'Wed, 21 Oct 2026 07:28:00 GMT'])(
    'ignores %j (only a count of seconds is honored)',
    (header) => {
      expect(retryAfterMsFromHeader(header)).toBeNull();
    },
  );
});

describe('formatFailure for API engines', () => {
  const en: Record<string, string> = {};
  for (const kind of API_FAILURE_KINDS) en[API_FAILURE_UI_KEYS[kind]] = `${kind} {0}.`;
  const t = createLookup({ en, es: {} } satisfies Catalogs, 'en');

  it.each(API_FAILURE_KINDS)('maps %s to its own key with the engine name', (kind) => {
    expect(formatFailure(new ApiProviderError('Gemini', kind), t)).toBe(`${kind} Gemini.`);
  });

  it('appends the sanitized detail for Unknown', () => {
    expect(formatFailure(new ApiProviderError('Gemini', 'Unknown', 'HTTP 500'), t)).toBe(
      'Unknown Gemini. HTTP 500',
    );
  });

  it('lists every API key with the other failure keys', () => {
    for (const key of Object.values(API_FAILURE_UI_KEYS)) {
      expect(SUMMARY_FAILURE_CATALOG_KEYS).toContain(key);
    }
  });
});
