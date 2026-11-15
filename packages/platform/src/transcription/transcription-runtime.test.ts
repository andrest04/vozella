import {
  CancelSource,
  FakeAsrEngine,
  FakeAudioReader,
  FakeModelStore,
  FakeRuntimeStore,
  FakeSpeechTimer,
  InMemorySettingsStore,
  type AppSettings,
  type CloudTranscriptionKind,
  type Logger,
} from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import { FakeApiKeyStore } from '../fakes/fake-api-key-store';
import { FakeSpeechToTextClient } from '../fakes/fake-speech-to-text-client';
import { systemSpeechTimer, TranscriptionRuntime } from './transcription-runtime';

const RATE = 16_000;
const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup(options: { cloud?: boolean; localReady?: boolean } = {}) {
  const engine = new FakeAsrEngine();
  const models = new FakeModelStore();
  const runtimes = new FakeRuntimeStore();
  if (options.localReady !== false) {
    models.model = true;
    runtimes.ready.add('cpu');
  }
  const settings = new InMemorySettingsStore();
  const keys = new FakeApiKeyStore();
  const clients: { kind: CloudTranscriptionKind; settings: AppSettings }[] = [];
  const made: FakeSpeechToTextClient[] = [];
  const runtime = new TranscriptionRuntime({
    transcriptionModelsDirectory: 'unused',
    nemoSpeechDirectory: 'unused',
    engine,
    hardware: () => Promise.resolve({ gpuName: null }),
    logger,
    audio: new FakeAudioReader(new Float32Array(2 * RATE).fill(0.25)),
    stores: { models, runtimes },
    settings,
    ...(options.cloud === false
      ? {}
      : {
          cloud: {
            keys,
            client: (kind, saved) => {
              clients.push({ kind, settings: saved });
              const client = new FakeSpeechToTextClient({ phrases: ['uno dos tres cuatro'] });
              made.push(client);
              return client;
            },
            timer: new FakeSpeechTimer(),
          },
        }),
  });
  return { runtime, engine, models, runtimes, settings, keys, clients, made };
}

const offline = (runtime: TranscriptionRuntime) =>
  runtime.offline.transcribe({
    audioPath: 'C:/a.wav',
    language: 'es',
    recordedAtMs: null,
    speakerDiarization: false,
  });

describe('TranscriptionRuntime: the selected engine', () => {
  it('is the local engine by default, for a missing value and for an unknown one', async () => {
    const { runtime, settings } = setup();
    expect((await runtime.engine()).kind).toBe('Local');
    await settings.update({ transcriptionEngine: 'Whisper' });
    expect((await runtime.engine()).kind).toBe('Local');
    expect(await (await runtime.engine()).isReady()).toBe(true);
  });

  it('is the cloud engine the setting names, ready with that key and no local model', async () => {
    const { runtime, settings, keys } = setup({ localReady: false });
    await settings.update({ transcriptionEngine: 'Groq' });
    const engine = await runtime.engine();
    expect(engine.kind).toBe('Groq');
    expect(await engine.isReady()).toBe(false);
    await keys.set('OpenAi', 'sk-other');
    expect(await engine.isReady()).toBe(false);
    await keys.set('Groq', 'gsk-test');
    expect(await engine.isReady()).toBe(true);
    // The local engine is still not installed: nothing was downloaded for the cloud one.
    expect(runtime.installer.isReady()).toBe(false);
  });

  it('stays local when the build wires no cloud engines', async () => {
    const { runtime, settings } = setup({ cloud: false });
    await settings.update({ transcriptionEngine: 'Groq' });
    expect((await runtime.engine()).kind).toBe('Local');
  });

  it('picks the engine when a pass starts: the next pass follows a changed setting', async () => {
    const { runtime, settings, engine, clients, made } = setup();
    await settings.update({ transcriptionEngine: 'Groq', cloudTranscriptionModelId: 'whisper-x' });
    const text = await offline(runtime);
    expect(text).toBe('[00:00.00-00:01.90] uno dos tres cuatro');
    expect(clients.map((entry) => entry.kind)).toEqual(['Groq']);
    expect(clients[0]?.settings.cloudTranscriptionModelId).toBe('whisper-x');
    expect(made[0]?.requests).toHaveLength(1);
    expect(engine.recognizers).toHaveLength(0);

    await settings.update({ transcriptionEngine: 'Local' });
    await offline(runtime);
    expect(engine.recognizers).toHaveLength(1);
    expect(clients).toHaveLength(1);

    await settings.update({ transcriptionEngine: 'OpenAi' });
    await offline(runtime);
    expect(clients.map((entry) => entry.kind)).toEqual(['Groq', 'OpenAi']);
  });

  it('a pass keeps the engine it started with when the setting changes under it', async () => {
    const { runtime, settings, engine, made } = setup();
    await settings.update({ transcriptionEngine: 'Groq' });
    await runtime.live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await settings.update({ transcriptionEngine: 'Local' });
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    const text = await runtime.live.stop();
    expect(made[0]?.requests).toHaveLength(1);
    expect(text).toBe('[00:00.00-00:00.90] uno dos');
    expect(engine.recognizers).toHaveLength(0);
    expect(runtime.live.lastDraftIsComplete).toBe(true);
  });
});

describe('systemSpeechTimer', () => {
  it('waits, and stops waiting as soon as the pass is cancelled', async () => {
    const before = systemSpeechTimer.nowMs();
    await systemSpeechTimer.wait(5, new CancelSource().signal);
    expect(systemSpeechTimer.nowMs()).toBeGreaterThanOrEqual(before);

    const cancel = new CancelSource();
    const started = Date.now();
    const waiting = systemSpeechTimer.wait(60_000, cancel.signal);
    cancel.cancel();
    await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);

    // Already cancelled: no wait at all.
    await systemSpeechTimer.wait(60_000, cancel.signal);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
