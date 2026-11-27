import { describe, expect, it } from 'vitest';
import {
  ELEVENLABS_API_KEY_HEADER,
  ELEVENLABS_BASE_URL,
  ELEVENLABS_BATCH_MODELS,
  ELEVENLABS_DEFAULT_BATCH_MODEL,
  ELEVENLABS_DEFAULT_LIVE_MODEL,
  ELEVENLABS_LIVE_MODELS,
  ELEVENLABS_REALTIME_SAMPLE_RATE,
  elevenLabsFailureFromHttpStatus,
  elevenLabsFailureKind,
  elevenLabsLanguageCode,
  elevenLabsLiveModel,
  elevenLabsRealtimeUrl,
  elevenLabsWords,
  isElevenLabsRealtimeError,
} from './elevenlabs-scribe';

describe('elevenlabs-scribe: constants', () => {
  it('names the API base and the key header', () => {
    expect(ELEVENLABS_BASE_URL).toBe('https://api.elevenlabs.io/v1');
    expect(ELEVENLABS_API_KEY_HEADER).toBe('xi-api-key');
  });

  it('lists the batch and live models with the newest first as the default', () => {
    expect(ELEVENLABS_BATCH_MODELS).toEqual(['scribe_v3', 'scribe_v2']);
    expect(ELEVENLABS_LIVE_MODELS).toEqual(['scribe_v3_live', 'scribe_v2_realtime']);
    expect(ELEVENLABS_DEFAULT_BATCH_MODEL).toBe('scribe_v3');
    expect(ELEVENLABS_DEFAULT_LIVE_MODEL).toBe('scribe_v3_live');
  });
});

describe('elevenLabsLiveModel', () => {
  it.each([
    ['scribe_v3', 'scribe_v3_live'],
    ['scribe_v2', 'scribe_v2_realtime'],
    [' scribe_v2 ', 'scribe_v2_realtime'],
    ['something-else', 'scribe_v3_live'],
    ['', 'scribe_v3_live'],
  ])('pairs the batch model %j with the live model %s', (batch, live) => {
    expect(elevenLabsLiveModel(batch)).toBe(live);
  });
});

describe('elevenLabsLanguageCode', () => {
  it.each([
    ['es-US', 'es'],
    ['es', 'es'],
    ['EN_gb', 'en'],
    ['pt-BR', 'pt'],
    ['es-419', 'es'],
  ])('sends %j as %j', (language, code) => {
    expect(elevenLabsLanguageCode(language)).toBe(code);
  });

  it.each(['auto', 'AUTO', '', '  '])(
    'sends no language for %j so Scribe detects it',
    (language) => {
      expect(elevenLabsLanguageCode(language)).toBeNull();
    },
  );
});

describe('elevenLabsWords', () => {
  it('keeps only spoken words, in milliseconds', () => {
    expect(
      elevenLabsWords([
        { text: 'Hola', type: 'word', start: 0.1, end: 0.42, speaker_id: 'speaker_0' },
        { text: ' ', type: 'spacing', start: 0.42, end: 0.5 },
        { text: '(risas)', type: 'audio_event', start: 0.5, end: 1.0 },
        { text: 'todos.', type: 'word', start: 1.0, end: 1.4 },
      ]),
    ).toEqual([
      { text: 'Hola', startMs: 100, endMs: 420 },
      { text: 'todos.', startMs: 1000, endMs: 1400 },
    ]);
  });

  it('distrusts the answer: no text, no start or a bad entry is dropped', () => {
    expect(
      elevenLabsWords([
        null,
        'word',
        { text: '  ', type: 'word', start: 0, end: 1 },
        { text: 'sin', type: 'word', start: null, end: 1 },
        { text: 'tipo', start: 0, end: 1 },
        { text: ' ok ', type: 'word', start: -0.2, end: -0.5 },
        { text: 'fin', type: 'word', start: 2, end: null },
      ]),
    ).toEqual([
      { text: 'ok', startMs: 0, endMs: 0 },
      { text: 'fin', startMs: 2000, endMs: 2000 },
    ]);
  });

  it.each([undefined, null, {}, 'words'])('answers no words for %j', (words) => {
    expect(elevenLabsWords(words)).toEqual([]);
  });
});

describe('elevenLabsFailureKind: realtime message types', () => {
  it.each([
    ['auth_error', 'KeyInvalid'],
    ['unaccepted_terms', 'KeyInvalid'],
    ['quota_exceeded', 'QuotaExceeded'],
    ['rate_limited', 'RateLimited'],
    ['commit_throttled', 'RateLimited'],
    ['queue_overflow', 'RateLimited'],
    ['resource_exhausted', 'RateLimited'],
    ['session_time_limit_exceeded', 'TimedOut'],
    ['insufficient_audio_activity', 'TimedOut'],
    ['transcriber_error', 'TimedOut'],
    ['input_error', 'Unknown'],
    ['invalid_request', 'Unknown'],
    ['chunk_size_exceeded', 'Unknown'],
    ['error', 'Unknown'],
    [' Auth_Error ', 'KeyInvalid'],
    ['something_new', 'Unknown'],
    [undefined, 'Unknown'],
    [42, 'Unknown'],
  ])('maps %j to %s', (messageType, kind) => {
    expect(elevenLabsFailureKind(messageType)).toBe(kind);
  });
});

describe('elevenLabsRealtimeUrl', () => {
  it('opens the realtime path over wss with manual commits, timestamps and 16 kHz PCM', () => {
    const url = new URL(elevenLabsRealtimeUrl(ELEVENLABS_BASE_URL, 'scribe_v2_realtime', 'es-US'));
    expect(url.origin + url.pathname).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      commit_strategy: 'manual',
      include_timestamps: 'true',
      language_code: 'es',
    });
    expect(ELEVENLABS_REALTIME_SAMPLE_RATE).toBe(16_000);
  });

  it('leaves the language out for auto, so Scribe detects it', () => {
    const url = new URL(elevenLabsRealtimeUrl(ELEVENLABS_BASE_URL, 'scribe_v3_live', 'auto'));
    expect(url.searchParams.has('language_code')).toBe(false);
  });

  it('keeps a plain http base for tests as ws, and drops a trailing slash', () => {
    const url = new URL(elevenLabsRealtimeUrl('http://localhost:9/v1/', 'm', 'en'));
    expect(url.origin + url.pathname).toBe('ws://localhost:9/v1/speech-to-text/realtime');
  });
});

describe('isElevenLabsRealtimeError', () => {
  it.each([
    'error',
    'auth_error',
    'quota_exceeded',
    'commit_throttled',
    'unaccepted_terms',
    'rate_limited',
    'queue_overflow',
    'resource_exhausted',
    'session_time_limit_exceeded',
    'input_error',
    'invalid_request',
    'chunk_size_exceeded',
    'insufficient_audio_activity',
    'transcriber_error',
  ])('reads %s as an error', (messageType) => {
    expect(isElevenLabsRealtimeError(messageType)).toBe(true);
  });

  it.each(['warning', 'session_started', 'partial_transcript', 'something_new', 7, undefined])(
    'does not read %j as an error',
    (messageType) => {
      expect(isElevenLabsRealtimeError(messageType)).toBe(false);
    },
  );
});

describe('elevenLabsFailureFromHttpStatus', () => {
  const detail = (fields: Record<string, string>): string => JSON.stringify({ detail: fields });

  it.each([
    [401, detail({ type: 'authentication_error', code: 'invalid_api_key' }), 'KeyInvalid'],
    [403, detail({ type: 'authorization_error', code: 'insufficient_permissions' }), 'KeyInvalid'],
    [402, detail({ type: 'payment_required', code: 'insufficient_credits' }), 'QuotaExceeded'],
    [429, detail({ type: 'rate_limit_error', code: 'rate_limit_exceeded' }), 'RateLimited'],
    [429, detail({ type: 'rate_limit_error', code: 'concurrent_limit_exceeded' }), 'RateLimited'],
    [429, detail({ type: 'rate_limit_error', code: 'system_busy' }), 'RateLimited'],
    [
      429,
      detail({ type: 'rate_limit_error', code: 'daily_generation_limit_reached' }),
      'QuotaExceeded',
    ],
    [401, detail({ status: 'quota_exceeded', message: 'no credits left' }), 'QuotaExceeded'],
    [404, detail({ type: 'not_found', code: 'model_not_found' }), 'ModelNotFound'],
    [400, detail({ type: 'validation_error', code: 'invalid_audio' }), 'Unknown'],
    [422, '{"detail":[{"loc":["body","model_id"],"msg":"bad","type":"value_error"}]}', 'Unknown'],
    [500, detail({ type: 'internal_error', code: 'internal_error' }), 'TimedOut'],
    [503, detail({ type: 'service_unavailable', code: 'maintenance' }), 'TimedOut'],
    [502, 'bad gateway', 'TimedOut'],
    [429, 'not json', 'RateLimited'],
  ])('maps HTTP %i with %s to %s', (status, body, kind) => {
    expect(elevenLabsFailureFromHttpStatus(status, body)).toBe(kind);
  });
});
