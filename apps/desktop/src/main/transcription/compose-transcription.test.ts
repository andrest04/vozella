import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApiProviderError,
  encodePcm16Wav,
  InMemorySettingsStore,
  MeetingBusyRegistry,
  PatchQueue,
  Workspace,
  type AppSettings,
  type AsrEngine,
  type HardwareProbe,
  type TranslateFn,
} from '@vozella/core';
import { FakeApiKeyStore, FakeFetch, type LibraryRuntime } from '@vozella/platform';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { recordingIpc, requestChannelsWithPrefix, silentLogger } from '../compose-test-kit';
import { composeTranscription, type ComposeTranscriptionDeps } from './compose-transcription';

function compose(overrides: Partial<ComposeTranscriptionDeps> = {}) {
  const { server, channels } = recordingIpc();
  const root = path.join(os.tmpdir(), 'vozella-compose-transcription-test');
  const stopOnExit = vi.fn();
  const unsubscribe = vi.fn();
  const audio = { onPush: vi.fn(() => unsubscribe) };
  const controller = composeTranscription({
    library: {
      paths: {
        transcriptionModelsDirectory: path.join(root, 'models'),
        nemoSpeechDirectory: path.join(root, 'nemo'),
      },
      settings: {},
      meetings: {},
    } as unknown as Pick<LibraryRuntime, 'paths' | 'settings' | 'meetings'>,
    asr: {} as AsrEngine,
    fakeNative: true,
    env: {},
    apiKeys: new FakeApiKeyStore(),
    hardware: { detect: () => Promise.resolve({ gpuName: null }) } as unknown as HardwareProbe,
    audio,
    busy: new MeetingBusyRegistry(),
    workspace: new Workspace(),
    broadcast: vi.fn(),
    logger: silentLogger(),
    translate: (key) => key,
    fileExists: () => true,
    queue: new PatchQueue(),
    summarize: () => Promise.resolve({ status: 'skipped' }),
    formatFailure: String,
    reveal: vi.fn(),
    server,
    stopOnExit,
    ...overrides,
  });
  return { controller, channels, stopOnExit, audio };
}

describe('composeTranscription', () => {
  it('registers the transcription, re-transcription and session request channels once', () => {
    const { channels } = compose();
    expect([...channels].sort()).toEqual(
      requestChannelsWithPrefix('transcription.', 'retranscription.', 'session.'),
    );
  });

  it('reads meetings from the current Library folder after it changes', async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    const server = {
      ipc: {
        handle: (name: string, handler: (event: unknown, input: unknown) => unknown) => {
          handlers.set(name, handler);
        },
      },
      logger: silentLogger(),
      isTrusted: () => true,
    };
    const before = { get: vi.fn(() => Promise.resolve(null)) };
    const after = { get: vi.fn(() => Promise.resolve(null)) };
    let current: unknown = before;
    const library = {
      paths: { transcriptionModelsDirectory: 'models', nemoSpeechDirectory: 'nemo' },
      settings: {},
      get meetings() {
        return current;
      },
    } as unknown as Pick<LibraryRuntime, 'paths' | 'settings' | 'meetings'>;
    compose({ library, server: server as unknown as ComposeTranscriptionDeps['server'] });
    current = after;
    const getView = handlers.get('session.getView');
    if (!getView) throw new Error('session.getView is not registered');
    await getView({ senderFrame: null }, { id: 'm1' });
    expect(after.get).toHaveBeenCalledWith('m1');
    expect(before.get).not.toHaveBeenCalled();
  });

  it('disposes the controller on a real quit', () => {
    const { controller, stopOnExit } = compose();
    expect(stopOnExit).toHaveBeenCalledTimes(1);
    const dispose = vi.spyOn(controller, 'dispose');
    (stopOnExit.mock.calls[0]?.[0] as () => void)();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('composeTranscription: cloud transcription engines', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vozella-compose-cloud-test-'));
  const wav = path.join(folder, 'take.wav');
  fs.writeFileSync(wav, encodePcm16Wav(new Float32Array(2 * 16_000).fill(0.25), 16_000));
  afterAll(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  async function cloudLibrary(patch: Partial<AppSettings>) {
    const settings = new InMemorySettingsStore();
    await settings.update(patch);
    return {
      paths: {
        transcriptionModelsDirectory: path.join(folder, 'models'),
        nemoSpeechDirectory: path.join(folder, 'nemo'),
      },
      settings,
      meetings: {},
    } as unknown as Pick<LibraryRuntime, 'paths' | 'settings' | 'meetings'>;
  }

  it('fake native: a cloud engine hears the fake client and never opens a connection', async () => {
    const fake = new FakeFetch({ networkError: true });
    const { controller } = compose({
      library: await cloudLibrary({ transcriptionEngine: 'Groq' }),
      apiKeys: new FakeApiKeyStore({ Groq: 'gsk-fake' }),
      fakeNative: true,
      env: { VOZELLA_FAKE_ASR_PHRASES: 'uno dos tres cuatro' },
      fetch: fake.fetch,
    });
    expect(await controller.status()).toMatchObject({ engine: 'Groq', ready: true });
    const text = await controller.transcribeFile({ audioPath: wav, recordedAtMs: null });
    expect(text).toMatch(/^\[00:00\.00-00:01\.90\] \S+ \S+ \S+ \S+$/);
    expect(fake.calls).toHaveLength(0);
  });

  it('fake native: the failure the environment asks for comes from the fake client', async () => {
    const { controller } = compose({
      library: await cloudLibrary({ transcriptionEngine: 'OpenAi' }),
      apiKeys: new FakeApiKeyStore({ OpenAi: 'sk-fake' }),
      fakeNative: true,
      env: { VOZELLA_FAKE_STT_FAIL: 'KeyInvalid' },
    });
    const run = controller.transcribeFile({ audioPath: wav, recordedAtMs: null });
    await expect(run).rejects.toBeInstanceOf(ApiProviderError);
    await expect(run).rejects.toMatchObject({ kind: 'KeyInvalid', displayName: 'Fake speech' });
  });

  it('fake native: without the key the engine is not ready, and Local stays the default', async () => {
    const { controller } = compose({
      library: await cloudLibrary({ transcriptionEngine: 'Groq' }),
      fakeNative: true,
    });
    expect(await controller.status()).toMatchObject({
      engine: 'Groq',
      ready: false,
      cloudNotReadyReason: 'key-missing',
    });
    const local = compose({ library: await cloudLibrary({}), fakeNative: true });
    expect(await local.controller.status()).toMatchObject({
      engine: 'Local',
      cloudNotReadyReason: null,
    });
  });

  it('the app: uploads to the provider with the stored key and the saved model', async () => {
    const fake = new FakeFetch({
      chunks: [
        JSON.stringify({
          text: 'hola a todos',
          duration: 2,
          words: [
            { word: 'hola', start: 0.1, end: 0.4 },
            { word: 'a', start: 0.5, end: 0.6 },
            { word: 'todos', start: 0.7, end: 1.4 },
          ],
        }),
      ],
    });
    const { controller } = compose({
      library: await cloudLibrary({
        transcriptionEngine: 'Groq',
        cloudTranscriptionModelId: 'whisper-large-v3',
        transcriptionLanguage: 'es',
      }),
      apiKeys: new FakeApiKeyStore({ Groq: 'gsk-stored-key' }),
      fakeNative: false,
      fetch: fake.fetch,
    });
    const text = await controller.transcribeFile({ audioPath: wav, recordedAtMs: null });
    expect(text).toBe('[00:00.10-00:01.40] hola a todos');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(call?.headers.authorization).toBe('Bearer gsk-stored-key');
    expect(call?.form?.get('model')).toBe('whisper-large-v3');
    expect(call?.form?.get('language')).toBe('es');
  });

  it('the app: an API failure is worded with its own sentence, other failures as before', async () => {
    const fake = new FakeFetch({ status: 401, chunks: ['{"error":{"message":"bad key"}}'] });
    const translate: TranslateFn = (key, ...args) => [key, ...args.map(String)].join('|');
    const formatFailure = vi.fn(() => 'other failure');
    const library = await cloudLibrary({
      transcriptionEngine: 'Groq',
      selectedSummaryProvider: null,
    });
    const meeting = {
      id: 'm1',
      title: 'Weekly',
      recordedAt: '2026-11-02T14:00:00.0000000+00:00',
      endedAt: null,
      audioFilePath: wav,
      transcript: 'old',
    };
    (library as { meetings: unknown }).meetings = {
      get: () => Promise.resolve(meeting),
      save: vi.fn(),
    };
    const finished: unknown[] = [];
    const { controller } = compose({
      library,
      apiKeys: new FakeApiKeyStore({ Groq: 'gsk-wrong' }),
      fakeNative: false,
      fetch: fake.fetch,
      translate,
      formatFailure,
      broadcast: (channel, payload) => {
        if (channel.name === 'retranscription.finished') finished.push(payload);
      },
    });
    await controller.startRetranscription('m1');
    await vi.waitFor(() => {
      expect(finished).toHaveLength(1);
    });
    expect(finished[0]).toMatchObject({
      outcome: 'Failed',
      message: 'Error_TranscriptionFailedAudioKept|Ui_ApiKeyInvalid|Groq',
    });
    expect(formatFailure).not.toHaveBeenCalled();
  });
});
