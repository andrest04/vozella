import { describe, expect, it } from 'vitest';
import { API_PROVIDER_KINDS, readSettings } from '../library/settings';
import { API_ENGINE_LIST } from './api-engine-table';
import {
  isTranscriptionProviderKind,
  TRANSCRIPTION_PROVIDERS,
  TRANSCRIPTION_PROVIDER_KINDS,
  TRANSCRIPTION_PROVIDER_LIST,
} from './transcription-provider-table';

describe('the transcription-only provider table', () => {
  it('declares Deepgram, then ElevenLabs', () => {
    expect([...TRANSCRIPTION_PROVIDER_KINDS]).toEqual(['Deepgram', 'ElevenLabs']);
  });

  it('checks a Deepgram key with a GET of its projects, under the Token scheme', () => {
    expect(TRANSCRIPTION_PROVIDERS.Deepgram).toMatchObject({
      kind: 'Deepgram',
      displayName: 'Deepgram',
      nameKey: 'Ui_DeepgramName',
      defaultBaseUrl: 'https://api.deepgram.com/v1',
      keyCheck: { method: 'GET', path: '/projects', header: 'authorization', authScheme: 'Token' },
    });
  });

  it('checks an ElevenLabs key by asking for a realtime Scribe token, with the bare key in xi-api-key', () => {
    expect(TRANSCRIPTION_PROVIDERS.ElevenLabs).toMatchObject({
      kind: 'ElevenLabs',
      displayName: 'ElevenLabs',
      nameKey: 'Ui_ElevenLabsName',
      defaultBaseUrl: 'https://api.elevenlabs.io/v1',
      keyCheck: {
        method: 'POST',
        path: '/single-use-token/realtime_scribe',
        header: 'xi-api-key',
        authScheme: null,
      },
    });
  });

  it.each(Object.entries(TRANSCRIPTION_PROVIDERS))('files %s under its own kind', (key, row) => {
    expect(row.kind).toBe(key);
  });

  it.each(TRANSCRIPTION_PROVIDER_LIST)(
    '$kind: a fixed https endpoint without a trailing slash',
    (provider) => {
      expect(provider.defaultBaseUrl).toMatch(/^https:\/\/[a-z0-9.-]+(\/[a-z0-9/-]*[a-z0-9])?$/);
      expect(provider.resolveBaseUrl(readSettings({}))).toBe(provider.defaultBaseUrl);
      expect(provider.keyCheck.path).toMatch(/^\/[a-z0-9/_-]+$/);
      // A header name in lower case, as `fetch` sends it.
      expect(provider.keyCheck.header).toMatch(/^[a-z][a-z0-9-]*$/);
    },
  );

  it.each(TRANSCRIPTION_PROVIDER_LIST)(
    '$kind is not a summary or chat engine: no API engine has its kind or name',
    (provider) => {
      expect(API_PROVIDER_KINDS as readonly string[]).not.toContain(provider.kind);
      expect(API_ENGINE_LIST.map((engine) => engine.displayName)).not.toContain(
        provider.displayName,
      );
      expect(API_ENGINE_LIST.map((engine) => engine.nameKey as string)).not.toContain(
        provider.nameKey,
      );
    },
  );
});

describe('isTranscriptionProviderKind', () => {
  it.each(['Deepgram', 'ElevenLabs'])('knows %s', (kind) => {
    expect(isTranscriptionProviderKind(kind)).toBe(true);
  });

  it.each(['Groq', 'OpenAi', 'Local', 'deepgram', 'elevenlabs', '', null, undefined])(
    '%s is not one',
    (kind) => {
      expect(isTranscriptionProviderKind(kind)).toBe(false);
    },
  );
});
