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
  type ApiKeyStore,
  type AppSettings,
  type AsrEngine,
  type HardwareProbe,
  type TranslateFn,
} from '@vozella/core';
import {
  FakeApiKeyStore,
  FakeFetch,
  ScriptedLiveSockets,
  type LibraryRuntime,
} from '@vozella/platform';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { recordingIpc, requestChannelsWithPrefix, silentLogger } from '../compose-test-kit';
import type { AudioPushEvent } from '../workers/audio-worker-host';
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

describe('composeTranscription: the key of a transcription-only provider', () => {
  /** Calls a registered request the way the IPC server does, from a trusted frame. */
  function composeWithHandlers(overrides: Partial<ComposeTranscriptionDeps>) {
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
    compose({ ...overrides, server: server as unknown as ComposeTranscriptionDeps['server'] });
    return (name: string, input: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} is not registered`);
      return handler({ senderFrame: null }, input);
    };
  }

  it('saves it in the app key store, where the engine status reads it', async () => {
    const apiKeys: ApiKeyStore = new FakeApiKeyStore();
    const call = composeWithHandlers({ apiKeys });
    expect(await call('transcription.setProviderKey', { kind: 'Deepgram', key: 'dg-key' })).toEqual(
      {
        ok: true,
        value: { status: 'saved', keySet: true },
      },
    );
    expect(await apiKeys.get('Deepgram')).toBe('dg-key');
  });

  it('fake native: Verify answers without opening a connection', async () => {
    const fake = new FakeFetch({ networkError: true });
    const apiKeys: ApiKeyStore = new FakeApiKeyStore();
    await apiKeys.set('Deepgram', 'dg-key');
    const call = composeWithHandlers({ apiKeys, fakeNative: true, fetch: fake.fetch });
    expect(await call('transcription.verifyProviderKey', { kind: 'Deepgram' })).toEqual({
      ok: true,
      value: { status: 'verified' },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('the app: Verify asks the provider with the stored key', async () => {
    const fake = new FakeFetch({ status: 401 });
    const apiKeys: ApiKeyStore = new FakeApiKeyStore();
    await apiKeys.set('Deepgram', 'dg-stored-key');
    const call = composeWithHandlers({ apiKeys, fakeNative: false, fetch: fake.fetch });
    expect(await call('transcription.verifyProviderKey', { kind: 'Deepgram' })).toEqual({
      ok: true,
      value: { status: 'failed', errorKey: 'Ui_ApiKeyInvalid' },
    });
    expect(fake.calls[0]).toMatchObject({
      url: 'https://api.deepgram.com/v1/projects',
      headers: { authorization: 'Token dg-stored-key' },
    });
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
    // An engine that only transcribes follows its key the same way.
    const deepgram = compose({
      library: await cloudLibrary({ transcriptionEngine: 'Deepgram' }),
      fakeNative: true,
    });
    expect(await deepgram.controller.status()).toMatchObject({
      engine: 'Deepgram',
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

  /** The capture's push events, so a test can feed the live pass recording frames. */
  function recordingAudio() {
    const listeners = new Set<(event: AudioPushEvent) => void>();
    return {
      audio: {
        onPush: (listener: (event: AudioPushEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      /** One second of mixed audio as the capture sends it: PCM16 at 16 kHz in 200 ms frames. */
      async second(): Promise<void> {
        for (let i = 0; i < 5; i += 1) {
          const pcm = new Uint8Array(new Int16Array(3_200).fill(8_000).buffer);
          for (const listener of listeners) listener({ type: 'recording-frame', pcm });
          for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
        }
      },
    };
  }

  it.each(['Deepgram', 'ElevenLabs'] as const)(
    'fake native: %s hears the fake session live and the fake client after Stop',
    async (kind) => {
      const fake = new FakeFetch({ networkError: true });
      const sockets = new ScriptedLiveSockets();
      const { audio, second } = recordingAudio();
      const updates: { displayText: string; committedText: string }[] = [];
      const { controller } = compose({
        library: await cloudLibrary({ transcriptionEngine: kind }),
        apiKeys: new FakeApiKeyStore({ [kind]: 'fake-key' }),
        fakeNative: true,
        env: { VOZELLA_FAKE_ASR_PHRASES: 'uno dos tres cuatro' },
        fetch: fake.fetch,
        socket: sockets.factory,
        audio,
        broadcast: (channel, payload) => {
          if (channel.name === 'transcription.liveUpdate') updates.push(payload as never);
        },
      });
      expect(await controller.status()).toMatchObject({ engine: kind, ready: true });
      await controller.startLive(null);
      await second();
      await second();
      // Word by word: the text on screen grows before any of it is committed.
      expect(updates[0]?.committedText).toBe('');
      expect(updates.length).toBeGreaterThan(1);
      const draft = await controller.stopLive();
      expect(draft).toMatch(/^\[00:00\.00-00:01\.90\] \S+ \S+ \S+ \S+$/);
      expect(controller.liveDraftIsFinal).toBe(true);
      // An imported file goes to the fake upload client. Neither opened a connection.
      const text = await controller.transcribeFile({ audioPath: wav, recordedAtMs: null });
      expect(text).toMatch(/^\[00:00\.00-00:01\.90\] \S+ \S+ \S+ \S+$/);
      expect(fake.calls).toHaveLength(0);
      expect(sockets.sockets).toHaveLength(0);
    },
  );

  it('fake native: the session failure the environment asks for stops the live text with its reason', async () => {
    const { audio, second } = recordingAudio();
    const { controller } = compose({
      library: await cloudLibrary({ transcriptionEngine: 'Deepgram' }),
      apiKeys: new FakeApiKeyStore({ Deepgram: 'dg-fake' }),
      fakeNative: true,
      env: { VOZELLA_FAKE_STREAM_FAIL: 'KeyInvalid' },
      audio,
      translate: (key, ...args) => [key, ...args.map(String)].join('|'),
    });
    const reasons: string[] = [];
    controller.onLiveFailure((reason) => reasons.push(reason));
    await controller.startLive(null);
    await second();
    expect(reasons).toEqual(['Ui_ApiKeyInvalid|Fake streaming speech']);
    expect(await controller.stopLive()).toBe('');
    expect(controller.liveDraftIsFinal).toBe(false);
  });

  it('the app: a streaming engine opens one live session with the stored key and its own model', async () => {
    const sockets = new ScriptedLiveSockets();
    const fake = new FakeFetch({ networkError: true });
    const { audio, second } = recordingAudio();
    const { controller } = compose({
      library: await cloudLibrary({
        transcriptionEngine: 'Deepgram',
        // Saved while Groq was the engine: it must not reach Deepgram.
        cloudTranscriptionModelId: 'whisper-large-v3-turbo',
        transcriptionLanguage: 'es',
      }),
      apiKeys: new FakeApiKeyStore({ Deepgram: 'dg-stored-key' }),
      fakeNative: false,
      fetch: fake.fetch,
      socket: sockets.factory,
      audio,
    });
    await controller.startLive(null);
    await second();
    expect(sockets.sockets).toHaveLength(1);
    const socket = sockets.sockets[0];
    const url = new URL(socket?.url ?? '');
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(socket?.headers).toEqual({ Authorization: 'Token dg-stored-key' });
    // The audio that waited for the open goes out as soon as the session takes it.
    socket?.open();
    expect(socket?.sentAudio.length).toBeGreaterThan(0);
    // Nothing is uploaded while the take records.
    expect(fake.calls).toHaveLength(0);
    const stopping = controller.stopLive();
    await vi.waitFor(() => {
      expect(socket?.sentTypes).toContain('CloseStream');
    });
    socket?.serverClose(1000);
    await stopping;
    expect(fake.calls).toHaveLength(0);
  });

  it('the app: a streaming engine uploads a finished recording to the prerecorded endpoint', async () => {
    const sockets = new ScriptedLiveSockets();
    const fake = new FakeFetch({
      chunks: [
        JSON.stringify({
          metadata: { duration: 2 },
          results: {
            channels: [
              {
                alternatives: [
                  {
                    transcript: 'Hola a todos.',
                    words: [
                      { word: 'hola', start: 0.1, end: 0.4, punctuated_word: 'Hola' },
                      { word: 'a', start: 0.5, end: 0.6, punctuated_word: 'a' },
                      { word: 'todos', start: 0.7, end: 1.4, punctuated_word: 'todos.' },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ],
    });
    const { controller } = compose({
      library: await cloudLibrary({
        transcriptionEngine: 'Deepgram',
        cloudTranscriptionModelId: 'whisper-large-v3-turbo',
        transcriptionLanguage: 'es',
      }),
      apiKeys: new FakeApiKeyStore({ Deepgram: 'dg-stored-key' }),
      fakeNative: false,
      fetch: fake.fetch,
      socket: sockets.factory,
    });
    const text = await controller.transcribeFile({ audioPath: wav, recordedAtMs: null });
    expect(text).toBe('[00:00.10-00:01.40] Hola a todos.');
    expect(fake.calls).toHaveLength(1);
    const url = new URL(fake.calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(fake.calls[0]?.headers.authorization).toBe('Token dg-stored-key');
    expect(sockets.sockets).toHaveLength(0);
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
