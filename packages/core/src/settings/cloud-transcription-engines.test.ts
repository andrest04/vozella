import { describe, expect, it } from 'vitest';
import { API_PROVIDER_KINDS, readSettings } from '../library/settings';
import { API_ENGINES } from './api-providers';
import {
  CLOUD_TRANSCRIPTION_ENGINES,
  CLOUD_TRANSCRIPTION_ENGINE_LIST,
  CLOUD_TRANSCRIPTION_KINDS,
  CLOUD_TRANSCRIPTION_MAX_FILE_BYTES,
  cloudTranscriptionApiEngine,
  cloudTranscriptionBaseUrl,
  isCloudTranscriptionKind,
  LOCAL_TRANSCRIPTION_ENGINE,
  resolveCloudTranscriptionModel,
  resolveTranscriptionEngine,
  TRANSCRIPTION_ENGINE_KINDS,
} from './cloud-transcription-engines';

describe('the cloud transcription engine table', () => {
  it('offers Groq first, then OpenAI', () => {
    expect([...CLOUD_TRANSCRIPTION_KINDS]).toEqual(['Groq', 'OpenAi']);
    expect(CLOUD_TRANSCRIPTION_ENGINE_LIST.map((engine) => engine.kind)).toEqual([
      'Groq',
      'OpenAi',
    ]);
  });

  it.each(Object.entries(CLOUD_TRANSCRIPTION_ENGINES))(
    'files %s under its own kind, which is an API engine kind',
    (key, engine) => {
      expect(engine.kind).toBe(key);
      expect(API_PROVIDER_KINDS).toContain(engine.kind);
    },
  );

  it('declares the transcription models and the default of each provider', () => {
    expect(CLOUD_TRANSCRIPTION_ENGINES.Groq.models).toEqual([
      'whisper-large-v3-turbo',
      'whisper-large-v3',
    ]);
    expect(CLOUD_TRANSCRIPTION_ENGINES.Groq.defaultModel).toBe('whisper-large-v3-turbo');
    expect(CLOUD_TRANSCRIPTION_ENGINES.OpenAi.models).toEqual(['whisper-1']);
    expect(CLOUD_TRANSCRIPTION_ENGINES.OpenAi.defaultModel).toBe('whisper-1');
  });

  it.each(CLOUD_TRANSCRIPTION_ENGINE_LIST)(
    '$kind: the default is a listed model and every model has a name',
    (engine) => {
      expect(engine.models).toContain(engine.defaultModel);
      expect(Object.keys(engine.modelNames)).toEqual([...engine.models]);
    },
  );

  it.each(CLOUD_TRANSCRIPTION_ENGINE_LIST)('$kind speaks the OpenAI audio protocol', (engine) => {
    expect(engine.protocol).toBe('openai-audio-transcriptions');
  });

  it('links the page of each provider where a key is created', () => {
    expect(CLOUD_TRANSCRIPTION_ENGINES.Groq.keyPageUrl).toBe('https://console.groq.com/keys');
    expect(CLOUD_TRANSCRIPTION_ENGINES.OpenAi.keyPageUrl).toBe(
      'https://platform.openai.com/api-keys',
    );
  });

  it.each(CLOUD_TRANSCRIPTION_ENGINE_LIST)(
    '$kind: the key page is a plain https page',
    (engine) => {
      // A host and a path, with no user, query or fragment: the link carries nothing about the user.
      expect(engine.keyPageUrl).toMatch(/^https:\/\/[a-z0-9.-]+\/[a-z0-9/-]*$/);
    },
  );

  it('records the limits the chunking engine must respect', () => {
    expect(CLOUD_TRANSCRIPTION_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(CLOUD_TRANSCRIPTION_ENGINES.Groq.limits).toEqual({
      requestsPerMinute: 20,
      audioSecondsPerHour: 7200,
      minBilledSeconds: 10,
    });
    expect(CLOUD_TRANSCRIPTION_ENGINES.OpenAi.limits).toEqual({
      requestsPerMinute: null,
      audioSecondsPerHour: null,
      minBilledSeconds: null,
    });
  });
});

describe('what the table reuses from the API engine table', () => {
  it.each(CLOUD_TRANSCRIPTION_KINDS)('%s resolves to the API engine of the same kind', (kind) => {
    expect(cloudTranscriptionApiEngine(kind)).toBe(API_ENGINES[kind]);
  });

  it('takes the base URL from the API engine', () => {
    const settings = readSettings({});
    expect(cloudTranscriptionBaseUrl('Groq', settings)).toBe('https://api.groq.com/openai/v1');
    expect(cloudTranscriptionBaseUrl('OpenAi', settings)).toBe('https://api.openai.com/v1');
    for (const kind of CLOUD_TRANSCRIPTION_KINDS) {
      expect(cloudTranscriptionBaseUrl(kind, settings)).toBe(
        API_ENGINES[kind].resolveBaseUrl(settings),
      );
    }
  });
});

describe('isCloudTranscriptionKind', () => {
  it.each(['Groq', 'OpenAi'])('%s can transcribe', (kind) => {
    expect(isCloudTranscriptionKind(kind)).toBe(true);
  });

  it.each(['Anthropic', 'Gemini', 'OpenAiCompatible', 'Local', '', null, undefined])(
    '%s cannot',
    (kind) => {
      expect(isCloudTranscriptionKind(kind)).toBe(false);
    },
  );
});

describe('resolveCloudTranscriptionModel', () => {
  it('uses the default when nothing is saved', () => {
    expect(resolveCloudTranscriptionModel('Groq', null)).toBe('whisper-large-v3-turbo');
    expect(resolveCloudTranscriptionModel('Groq', '  ')).toBe('whisper-large-v3-turbo');
    expect(resolveCloudTranscriptionModel('OpenAi', undefined)).toBe('whisper-1');
  });

  it('keeps a saved id, trimmed, even one the table does not list', () => {
    expect(resolveCloudTranscriptionModel('Groq', ' whisper-large-v3 ')).toBe('whisper-large-v3');
    // whisper-1 is deprecated: its successor must be usable without a release.
    expect(resolveCloudTranscriptionModel('OpenAi', 'whisper-next')).toBe('whisper-next');
  });
});

describe('the transcription engine setting', () => {
  it('offers Local first, then the cloud kinds of the table', () => {
    expect(LOCAL_TRANSCRIPTION_ENGINE).toBe('Local');
    expect([...TRANSCRIPTION_ENGINE_KINDS]).toEqual(['Local', ...CLOUD_TRANSCRIPTION_KINDS]);
  });

  it.each([
    [null, 'Local'],
    ['', 'Local'],
    ['Local', 'Local'],
    ['Groq', 'Groq'],
    ['OpenAi', 'OpenAi'],
    // An API engine that cannot transcribe, another case, or anything unknown is Local.
    ['Anthropic', 'Local'],
    ['groq', 'Local'],
    ['Whisper', 'Local'],
  ] as const)('reads %j as %s', (saved, kind) => {
    expect(resolveTranscriptionEngine({ transcriptionEngine: saved })).toBe(kind);
  });
});
