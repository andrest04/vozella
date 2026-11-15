import {
  CancelSource,
  FakeAsrEngine,
  FakeAudioReader,
  FakeModelStore,
  FakeRuntimeStore,
  FakeSpeechTimer,
  InMemorySettingsStore,
  type ApiKeyStore,
  type AppSettings,
  type CancelSignal,
  type CloudTranscriptionKind,
  type Logger,
} from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import { FakeApiKeyStore } from '../fakes/fake-api-key-store';
import { FakeSpeechToTextClient } from '../fakes/fake-speech-to-text-client';
import {
  systemSpeechTimer,
  TranscriptionRuntime,
  UnavailableSpeechEngineProvider,
} from './transcription-runtime';

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

describe('TranscriptionRuntime: an engine whose adapter does not exist yet (temporary)', () => {
  it('Deepgram is the selected engine but is not ready, with or without its key', async () => {
    const { runtime, settings, keys, clients } = setup();
    const store: ApiKeyStore = keys;
    await settings.update({ transcriptionEngine: 'Deepgram' });
    const engine = await runtime.engine();
    expect(engine.kind).toBe('Deepgram');
    expect(engine).toBeInstanceOf(UnavailableSpeechEngineProvider);
    expect(await engine.isReady()).toBe(false);
    await store.set('Deepgram', 'dg-test');
    expect(await (await runtime.engine()).isReady()).toBe(false);
    // The OpenAI-compatible client is never built for a provider that does not speak it.
    expect(clients).toEqual([]);
  });

  it('a pass on it fails with a plain reason and uploads nothing', async () => {
    const { runtime, settings, clients, engine } = setup();
    await settings.update({ transcriptionEngine: 'Deepgram' });
    await expect(offline(runtime)).rejects.toMatchObject({
      kind: 'Unknown',
      displayName: 'Deepgram',
    });
    expect(clients).toEqual([]);
    // It never falls back to the engine on this PC behind the user's back.
    expect(engine.recognizers).toHaveLength(0);
  });

  it('the engines that have an adapter are not affected', async () => {
    const { runtime, settings } = setup();
    await settings.update({ transcriptionEngine: 'Groq' });
    expect(await runtime.engine()).not.toBeInstanceOf(UnavailableSpeechEngineProvider);
  });
});

describe('TranscriptionRuntime: a live pass that cannot go on', () => {
  /** A live pass on Groq whose every upload fails with `failWith`, fed one piece of audio. */
  async function failingLivePass(failWith: string) {
    const engine = new FakeAsrEngine();
    const settings = new InMemorySettingsStore();
    await settings.update({ transcriptionEngine: 'Groq' });
    const runtime = new TranscriptionRuntime({
      transcriptionModelsDirectory: 'unused',
      nemoSpeechDirectory: 'unused',
      engine,
      hardware: () => Promise.resolve({ gpuName: null }),
      logger,
      stores: { models: new FakeModelStore(), runtimes: new FakeRuntimeStore() },
      settings,
      cloud: {
        keys: new FakeApiKeyStore({ Groq: 'k' }),
        client: () => new FakeSpeechToTextClient({ failWith }),
        timer: new FakeSpeechTimer(),
      },
    });
    const failures: { engine: string; error: unknown }[] = [];
    const off = runtime.onLiveFailure((failure) => failures.push(failure));
    await runtime.live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await runtime.live.stop();
    return { failures, off, runtime };
  }

  it('tells its listeners when the provider refuses the key, with the engine and the failure', async () => {
    const { failures } = await failingLivePass('KeyInvalid');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ engine: 'Groq', error: { kind: 'KeyInvalid' } });
  });

  it('says nothing for a failure that only leaves a gap', async () => {
    const { failures } = await failingLivePass('Network');
    expect(failures).toEqual([]);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const { failures, off, runtime } = await failingLivePass('QuotaExceeded');
    expect(failures).toHaveLength(1);
    off();
    await runtime.live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await runtime.live.stop();
    expect(failures).toHaveLength(1);
  });
});

describe('TranscriptionRuntime: cloud passes', () => {
  function cloudRuntime(
    options: {
      audioSeconds?: number;
      client?: () => FakeSpeechToTextClient;
      liveStopWait?: (ms: number, cancel: CancelSignal) => Promise<void>;
    } = {},
  ) {
    const settings = new InMemorySettingsStore();
    const timer = new FakeSpeechTimer();
    const runtime = new TranscriptionRuntime({
      transcriptionModelsDirectory: 'unused',
      nemoSpeechDirectory: 'unused',
      engine: new FakeAsrEngine(),
      hardware: () => Promise.resolve({ gpuName: null }),
      logger,
      audio: new FakeAudioReader(new Float32Array((options.audioSeconds ?? 2) * RATE).fill(0.25)),
      stores: { models: new FakeModelStore(), runtimes: new FakeRuntimeStore() },
      settings,
      cloud: {
        keys: new FakeApiKeyStore({ Groq: 'k', OpenAi: 'k' }),
        client: options.client ?? (() => new FakeSpeechToTextClient()),
        timer,
      },
      ...(options.liveStopWait ? { liveStopWait: options.liveStopWait } : {}),
    });
    return { runtime, settings, timer };
  }

  it('a live pass and the pass after it share the request pacing of their provider', async () => {
    const { runtime, settings, timer } = cloudRuntime();
    await settings.update({ transcriptionEngine: 'Groq' });
    await runtime.live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await runtime.live.stop();
    expect(timer.waits).toEqual([]);
    await offline(runtime);
    // The offline request waited for the slot after the live one: one limit, one pacer.
    expect(timer.waits).toEqual([3_000]);
  });

  it('each provider has its own pacing', async () => {
    const { runtime, settings, timer } = cloudRuntime();
    await settings.update({ transcriptionEngine: 'Groq' });
    await offline(runtime);
    await settings.update({ transcriptionEngine: 'OpenAi' });
    await offline(runtime);
    expect(timer.waits).toEqual([]);
  });

  it('Stop gives the live pass a deadline, then cuts it off and says the draft is not whole', async () => {
    const waits: number[] = [];
    let elapse = (): void => undefined;
    const { runtime, settings } = cloudRuntime({
      // An upload that takes ten minutes: far past any Stop.
      client: () => new FakeSpeechToTextClient({ delayMs: 600_000 }),
      liveStopWait: (ms, cancel) =>
        new Promise<void>((resolve) => {
          waits.push(ms);
          elapse = resolve;
          cancel.onCancel(resolve);
        }),
    });
    await settings.update({ transcriptionEngine: 'Groq' });
    await runtime.live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    let draft: string | null = null;
    void runtime.live.stop().then((text) => {
      draft = text;
    });
    await vi.waitFor(() => {
      expect(waits).toEqual([25_000]);
    });
    expect(draft).toBeNull();
    elapse();
    await vi.waitFor(() => {
      expect(draft).toBe('');
    });
    expect(runtime.live.lastDraftIsComplete).toBe(false);
    expect(runtime.status.lastLiveDrops).toEqual({ droppedMs: 1_000, totalMs: 1_000 });
  });

  it('the punctuation of the provider is in the stamped lines of a long recording', async () => {
    const { runtime, settings } = cloudRuntime({ audioSeconds: 40 });
    await settings.update({ transcriptionEngine: 'Groq' });
    const lines = (await offline(runtime)).split('\n');
    // 40 s is more than one 30 s line, so the lines are rebuilt from the words.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\[00:00\.00-00:29\.90\] Buenos días a todos y gracias por venir\. Hoy revisamos el presupuesto del trimestre\. Quedamos en cerrar /,
    );
    expect(lines[1]).toMatch(/^\[00:30\.00-00:39\.90\] /);
    expect(lines.join(' ')).not.toMatch(/venir hoy|trimestre quedamos/);
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
