import { describe, expect, it } from 'vitest';
import { requestChannels } from './channels';
import { apiProviderKindSchema, settingsPageSchema, settingsSetApiKey } from './settings';
import {
  cloudTranscriptionKindSchema,
  engineStatusSchema,
  transcriptionClearProviderKey,
  transcriptionEngineKindSchema,
  transcriptionProviderKindSchema,
  transcriptionSetProviderKey,
  transcriptionVerifyProviderKey,
} from './transcription';

describe('the transcription engine kinds', () => {
  it('lists the local engine, then the cloud kinds', () => {
    expect(cloudTranscriptionKindSchema.options).toEqual([
      'Groq',
      'OpenAi',
      'Deepgram',
      'ElevenLabs',
    ]);
    expect(transcriptionEngineKindSchema.options).toEqual([
      'Local',
      'Groq',
      'OpenAi',
      'Deepgram',
      'ElevenLabs',
    ]);
  });

  it('keeps the transcription-only providers out of the API engine kinds', () => {
    expect(transcriptionProviderKindSchema.options).toEqual(['Deepgram', 'ElevenLabs']);
    for (const kind of transcriptionProviderKindSchema.options) {
      expect(apiProviderKindSchema.options as readonly string[]).not.toContain(kind);
      // The key of a transcription-only provider never travels on the API engine channel.
      expect(settingsSetApiKey.input.safeParse({ kind, key: 'k' }).success).toBe(false);
    }
  });

  it('the only reason a cloud engine is not ready is its missing key', () => {
    expect(engineStatusSchema.shape.cloudNotReadyReason.unwrap().options).toEqual(['key-missing']);
    expect(engineStatusSchema.shape.cloudNotReadyReason.safeParse('unavailable').success).toBe(
      false,
    );
    expect(engineStatusSchema.shape.cloudNotReadyReason.safeParse(null).success).toBe(true);
  });

  it('carries on the Settings page whether each cloud engine has its key', () => {
    expect(Object.keys(settingsPageSchema.shape.transcriptionKeys.shape)).toEqual(
      cloudTranscriptionKindSchema.options,
    );
  });
});

describe('the key channels of the transcription-only providers', () => {
  it('are registered request channels', () => {
    expect(Object.keys(requestChannels)).toEqual(
      expect.arrayContaining([
        'transcription.setProviderKey',
        'transcription.clearProviderKey',
        'transcription.verifyProviderKey',
      ]),
    );
  });

  it('take a transcription-only provider and nothing else', () => {
    expect(
      transcriptionSetProviderKey.input.safeParse({ kind: 'Deepgram', key: 'dg-test' }).success,
    ).toBe(true);
    expect(transcriptionClearProviderKey.input.safeParse({ kind: 'Deepgram' }).success).toBe(true);
    expect(transcriptionVerifyProviderKey.input.safeParse({ kind: 'Deepgram' }).success).toBe(true);
    expect(
      transcriptionSetProviderKey.input.safeParse({ kind: 'ElevenLabs', key: 'xi-test' }).success,
    ).toBe(true);
    expect(transcriptionVerifyProviderKey.input.safeParse({ kind: 'ElevenLabs' }).success).toBe(
      true,
    );
    for (const kind of ['Groq', 'OpenAi', 'Local', 'deepgram', 'elevenlabs']) {
      expect(transcriptionSetProviderKey.input.safeParse({ kind, key: 'k' }).success).toBe(false);
      expect(transcriptionClearProviderKey.input.safeParse({ kind }).success).toBe(false);
      expect(transcriptionVerifyProviderKey.input.safeParse({ kind }).success).toBe(false);
    }
  });

  it('bound the key and never carry it back', () => {
    expect(
      transcriptionSetProviderKey.input.safeParse({ kind: 'Deepgram', key: 'x'.repeat(2001) })
        .success,
    ).toBe(false);
    // Verify checks the saved key: none travels with the request.
    expect(
      transcriptionVerifyProviderKey.input.safeParse({ kind: 'Deepgram', key: 'k' }).success,
    ).toBe(false);
    expect(
      transcriptionSetProviderKey.output.safeParse({ status: 'saved', keySet: true }).success,
    ).toBe(true);
    expect(
      transcriptionSetProviderKey.output.safeParse({ status: 'saved', keySet: true, key: 'k' })
        .success,
    ).toBe(false);
    expect(
      transcriptionClearProviderKey.output.safeParse({ status: 'saved', keySet: false }).success,
    ).toBe(true);
    expect(transcriptionVerifyProviderKey.output.safeParse({ status: 'verified' }).success).toBe(
      true,
    );
    expect(
      transcriptionVerifyProviderKey.output.safeParse({ status: 'verified', key: 'k' }).success,
    ).toBe(false);
    expect(
      transcriptionVerifyProviderKey.output.safeParse({
        status: 'failed',
        errorKey: 'Ui_ApiKeyInvalid',
      }).success,
    ).toBe(true);
  });
});
