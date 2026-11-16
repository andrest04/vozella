import { describe, expect, it } from 'vitest';
import {
  deepgramFailureKind,
  deepgramLanguage,
  deepgramListenQuery,
  deepgramWords,
} from './deepgram-listen';

describe('deepgramLanguage', () => {
  it.each([
    ['es', 'es'],
    ['es-US', 'es'],
    ['ES-us', 'es'],
    [' es_ES ', 'es'],
    ['es-419', 'es-419'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
  ])('asks for one language when the meeting is in %j', (tag, language) => {
    expect(deepgramLanguage(tag)).toEqual({ language, endpointingMs: null });
  });

  it.each(['auto', '', '  ', 'pt-BR', 'fr-FR', 'ja-JP', 'zh-CN', 'xx'])(
    'asks for the multilingual model with short endpointing for %j',
    (tag) => {
      expect(deepgramLanguage(tag)).toEqual({ language: 'multi', endpointingMs: 100 });
    },
  );
});

describe('deepgramListenQuery', () => {
  it('asks a finished file for punctuated text in its language', () => {
    const query = new URLSearchParams(deepgramListenQuery({ model: 'nova-3', language: 'es-US' }));
    expect(Object.fromEntries(query)).toEqual({
      model: 'nova-3',
      punctuate: 'true',
      smart_format: 'true',
      language: 'es',
    });
  });

  it('adds the audio format and interim results for a live stream', () => {
    const query = new URLSearchParams(
      deepgramListenQuery({ model: 'nova-3', language: 'en-US', live: { sampleRate: 16_000 } }),
    );
    expect(Object.fromEntries(query)).toEqual({
      model: 'nova-3',
      punctuate: 'true',
      smart_format: 'true',
      language: 'en',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
    });
  });

  it('adds the endpointing only to a live multilingual stream', () => {
    const live = new URLSearchParams(
      deepgramListenQuery({ model: 'nova-3', language: 'auto', live: { sampleRate: 48_000 } }),
    );
    expect(live.get('language')).toBe('multi');
    expect(live.get('endpointing')).toBe('100');
    const file = new URLSearchParams(deepgramListenQuery({ model: 'nova-3', language: 'auto' }));
    expect(file.get('language')).toBe('multi');
    expect(file.has('endpointing')).toBe(false);
  });
});

describe('deepgramWords', () => {
  it('reads the punctuated word and its times in milliseconds', () => {
    expect(
      deepgramWords([
        { word: 'hola', punctuated_word: 'Hola,', start: 0.08, end: 0.4, confidence: 0.9 },
        { word: 'mundo', start: 0.5, end: 0.92 },
      ]),
    ).toEqual([
      { text: 'Hola,', startMs: 80, endMs: 400 },
      { text: 'mundo', startMs: 500, endMs: 920 },
    ]);
  });

  it('drops what is not a timed word and never lets a word end before it starts', () => {
    expect(
      deepgramWords([
        null,
        'word',
        { word: '', start: 0, end: 1 },
        { word: 'sin', end: 1 },
        { word: 'tiempo', start: Number.NaN, end: 1 },
        { punctuated_word: 42, word: 'vale', start: 2, end: 1 },
        { word: ' final ', start: -1 },
      ]),
    ).toEqual([
      { text: 'vale', startMs: 2000, endMs: 2000 },
      { text: 'final', startMs: 0, endMs: 0 },
    ]);
  });

  it('reads nothing from anything that is not a list', () => {
    expect(deepgramWords(undefined)).toEqual([]);
    expect(deepgramWords({ word: 'x' })).toEqual([]);
  });
});

describe('deepgramFailureKind', () => {
  it.each([
    ['INVALID_AUTH', 'KeyInvalid'],
    ['INSUFFICIENT_PERMISSIONS', 'KeyInvalid'],
    ['ASR_PAYMENT_REQUIRED', 'QuotaExceeded'],
    ['TOO_MANY_REQUESTS', 'RateLimited'],
    ['NET-0001', 'TimedOut'],
    ['DATA-0000', 'Unknown'],
    ['something else', 'Unknown'],
    [undefined, 'Unknown'],
  ])('reads the error code %j as %s', (code, kind) => {
    expect(deepgramFailureKind(code)).toBe(kind);
  });
});
