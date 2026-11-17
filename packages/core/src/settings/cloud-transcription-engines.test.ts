import { describe, expect, it } from 'vitest';
import { API_PROVIDER_KINDS, readSettings } from '../library/settings';
import { API_ENGINES } from './api-providers';
import {
  TRANSCRIPTION_PROVIDERS,
  TRANSCRIPTION_PROVIDER_KINDS,
} from './transcription-provider-table';
import {
  CLOUD_TRANSCRIPTION_ENGINES,
  CLOUD_TRANSCRIPTION_ENGINE_LIST,
  CLOUD_TRANSCRIPTION_KINDS,
  CLOUD_TRANSCRIPTION_MAX_FILE_BYTES,
  cloudTranscriptionApiEngine,
  cloudTranscriptionProvider,
  isCloudTranscriptionKind,
  LOCAL_TRANSCRIPTION_ENGINE,
  resolveCloudTranscriptionModel,
  resolveTranscriptionEngine,
  TRANSCRIPTION_ENGINE_KINDS,
} from './cloud-transcription-engines';

describe('the cloud transcription engine table', () => {
  it('offers Groq first, then OpenAI, then Deepgram', () => {
    expect([...CLOUD_TRANSCRIPTION_KINDS]).toEqual(['Groq', 'OpenAi', 'Deepgram']);
    expect(CLOUD_TRANSCRIPTION_ENGINE_LIST.map((engine) => engine.kind)).toEqual([
      'Groq',
      'OpenAi',
      'Deepgram',
    ]);
  });

  it.each(Object.entries(CLOUD_TRANSCRIPTION_ENGINES))(
    'files %s under its own kind, which holds a key: an API engine or a transcription-only provider',
    (key, engine) => {
      expect(engine.kind).toBe(key);
      expect([...API_PROVIDER_KINDS, ...TRANSCRIPTION_PROVIDER_KINDS]).toContain(engine.kind);
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
    expect(CLOUD_TRANSCRIPTION_ENGINES.Deepgram.models).toEqual(['nova-3']);
    expect(CLOUD_TRANSCRIPTION_ENGINES.Deepgram.modelNames).toEqual({ 'nova-3': 'Nova-3' });
    expect(CLOUD_TRANSCRIPTION_ENGINES.Deepgram.defaultModel).toBe('nova-3');
  });

  it.each(CLOUD_TRANSCRIPTION_ENGINE_LIST)(
    '$kind: the default is a listed model and every model has a name',
    (engine) => {
      expect(engine.models).toContain(engine.defaultModel);
      expect(Object.keys(engine.modelNames)).toEqual([...engine.models]);
    },
  );

  it('names the protocol each provider speaks and how its live text arrives', () => {
    expect(
      CLOUD_TRANSCRIPTION_ENGINE_LIST.map((engine) => [
        engine.kind,
        engine.protocol,
        engine.liveText,
      ]),
    ).toEqual([
      ['Groq', 'openai-audio-transcriptions', 'pieces'],
      ['OpenAi', 'openai-audio-transcriptions', 'pieces'],
      ['Deepgram', 'deepgram-listen', 'streaming'],
    ]);
  });

  it('links the page of each provider where a key is created', () => {
    expect(CLOUD_TRANSCRIPTION_ENGINES.Groq.keyPageUrl).toBe('https://console.groq.com/keys');
    expect(CLOUD_TRANSCRIPTION_ENGINES.OpenAi.keyPageUrl).toBe(
      'https://platform.openai.com/api-keys',
    );
    expect(CLOUD_TRANSCRIPTION_ENGINES.Deepgram.keyPageUrl).toBe('https://console.deepgram.com/');
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
    // Deepgram's docs give no request or audio quota: nothing is invented.
    expect(CLOUD_TRANSCRIPTION_ENGINES.Deepgram.limits).toEqual({
      requestsPerMinute: null,
      audioSecondsPerHour: null,
      minBilledSeconds: null,
    });
  });
});

describe('where the name, the endpoint and the key of a cloud engine come from', () => {
  it.each(['Groq', 'OpenAi'] as const)('%s resolves to the API engine of the same kind', (kind) => {
    expect(cloudTranscriptionProvider(kind)).toBe(API_ENGINES[kind]);
  });

  it('Deepgram resolves to its transcription-only provider', () => {
    expect(cloudTranscriptionProvider('Deepgram')).toBe(TRANSCRIPTION_PROVIDERS.Deepgram);
    expect(cloudTranscriptionProvider('Deepgram').displayName).toBe('Deepgram');
  });

  it('keeps the older name of the lookup for its callers', () => {
    expect(cloudTranscriptionApiEngine).toBe(cloudTranscriptionProvider);
  });
});

describe('isCloudTranscriptionKind', () => {
  it.each(['Groq', 'OpenAi', 'Deepgram'])('%s can transcribe', (kind) => {
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
    expect(resolveCloudTranscriptionModel('Deepgram', null)).toBe('nova-3');
  });

  it('keeps a saved id the engine lists, trimmed', () => {
    expect(resolveCloudTranscriptionModel('Groq', ' whisper-large-v3 ')).toBe('whisper-large-v3');
  });

  it('a model saved for another engine never reaches this one: it gets its own default', () => {
    // One setting holds the model of whichever engine was selected when it was saved.
    expect(resolveCloudTranscriptionModel('Deepgram', 'whisper-large-v3-turbo')).toBe('nova-3');
    expect(resolveCloudTranscriptionModel('Groq', 'nova-3')).toBe('whisper-large-v3-turbo');
    expect(resolveCloudTranscriptionModel('OpenAi', 'whisper-large-v3')).toBe('whisper-1');
  });

  it('an id no engine lists is not sent either', () => {
    expect(resolveCloudTranscriptionModel('OpenAi', 'whisper-next')).toBe('whisper-1');
  });

  it.each(CLOUD_TRANSCRIPTION_ENGINE_LIST)('$kind resolves each of its own models', (engine) => {
    for (const model of engine.models) {
      expect(resolveCloudTranscriptionModel(engine.kind, model)).toBe(model);
    }
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
    ['Deepgram', 'Deepgram'],
    // An API engine that cannot transcribe, another case, or anything unknown is Local.
    ['Anthropic', 'Local'],
    ['groq', 'Local'],
    ['deepgram', 'Local'],
    ['Whisper', 'Local'],
  ] as const)('reads %j as %s', (saved, kind) => {
    expect(resolveTranscriptionEngine({ transcriptionEngine: saved })).toBe(kind);
  });
});
