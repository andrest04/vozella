import { describe, expect, it } from 'vitest';
import { createLookup, type Catalogs } from '../i18n/translator';
import {
  API_FAILURE_KINDS,
  ApiProviderError,
  apiFailureFromHttpStatus,
  isApiProviderError,
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
    [404, 'model not found', 'ModelNotFound'],
    [408, '', 'TimedOut'],
    [504, '', 'TimedOut'],
    [500, 'oops', 'Unknown'],
    [400, 'bad request', 'Unknown'],
  ] as const)('%i %j is %s', (status, body, kind) => {
    expect(apiFailureFromHttpStatus(status, body)).toBe(kind);
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
