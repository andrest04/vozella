import {
  ApiProviderError,
  CancelSource,
  FakeAsrEngine,
  FakeAudioReader,
  FakeModelStore,
  FakeRuntimeStore,
  FakeSpeechTimer,
  InMemorySettingsStore,
  ManualSpeechTimer,
  ScriptedStreamingSpeechProvider,
  STREAMING_OPEN_TIMEOUT_MS,
  type ApiKeyStore,
  type AppSettings,
  type CancelSignal,
  type CloudTranscriptionKind,
  type Logger,
  type StreamingSpeechProvider,
} from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import { FakeApiKeyStore } from '../fakes/fake-api-key-store';
import { FakeSpeechToTextClient } from '../fakes/fake-speech-to-text-client';
import { FakeStreamingSpeechProvider } from '../fakes/fake-streaming-speech-provider';
import {
  systemSpeechTimer,
  TranscriptionRuntime,
  type LiveTranscriptionFailure,
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

describe('TranscriptionRuntime: an engine whose live text is streamed', () => {
  /** Deepgram (or `kind`) selected with its key, and a streaming provider the test chooses. */
  async function streamingRuntime(
    options: {
      streaming?: StreamingSpeechProvider | null;
      key?: boolean;
      audioSeconds?: number;
      kind?: 'Deepgram' | 'ElevenLabs';
    } = {},
  ) {
    const kind = options.kind ?? 'Deepgram';
    const engine = new FakeAsrEngine();
    const settings = new InMemorySettingsStore();
    await settings.update({ transcriptionEngine: kind });
    const keys: ApiKeyStore = new FakeApiKeyStore();
    if (options.key !== false) await keys.set(kind, 'test-key');
    const clients: { kind: CloudTranscriptionKind; client: FakeSpeechToTextClient }[] = [];
    const asked: CloudTranscriptionKind[] = [];
    const streaming =
      options.streaming === undefined
        ? new FakeStreamingSpeechProvider({ phrases: ['uno dos tres cuatro'] })
        : options.streaming;
    // The uploads are paced on a clock that never sleeps. The streaming engine never takes it.
    const timer = new FakeSpeechTimer();
    const streamingTimer = new ManualSpeechTimer();
    const runtime = new TranscriptionRuntime({
      transcriptionModelsDirectory: 'unused',
      nemoSpeechDirectory: 'unused',
      engine,
      hardware: () => Promise.resolve({ gpuName: null }),
      logger,
      audio: new FakeAudioReader(new Float32Array((options.audioSeconds ?? 2) * RATE).fill(0.25)),
      stores: { models: new FakeModelStore(), runtimes: new FakeRuntimeStore() },
      settings,
      cloud: {
        keys,
        client: (kind) => {
          const client = new FakeSpeechToTextClient({ phrases: ['alfa beta gamma delta'] });
          clients.push({ kind, client });
          return client;
        },
        streaming: (kind) => {
          asked.push(kind);
          return streaming;
        },
        timer,
        streamingTimer,
      },
    });
    const failures: LiveTranscriptionFailure[] = [];
    runtime.onLiveFailure((failure) => failures.push(failure));
    return { runtime, engine, settings, keys, clients, asked, failures, timer, streamingTimer };
  }

  const startLive = (runtime: TranscriptionRuntime) =>
    runtime.live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });

  it('is ready with its key and nothing else, like every cloud engine', async () => {
    const { runtime, keys, asked, clients } = await streamingRuntime({ key: false });
    const engine = await runtime.engine();
    expect(engine.kind).toBe('Deepgram');
    expect(await engine.isReady()).toBe(false);
    await keys.set('Groq', 'gsk-other');
    expect(await engine.isReady()).toBe(false);
    await keys.set('Deepgram', 'dg-test');
    expect(await (await runtime.engine()).isReady()).toBe(true);
    // Asking is free: nothing is built, opened or uploaded until a pass starts.
    expect(asked).toEqual([]);
    expect(clients).toEqual([]);
  });

  it('a live pass is one streaming session: interim text rewrites, finals commit, nothing is uploaded', async () => {
    const { runtime, clients, asked, engine } = await streamingRuntime();
    const updates: { displayText: string; committedText: string }[] = [];
    runtime.live.onTranscriptUpdated((update) => updates.push(update));
    await startLive(runtime);
    for (let i = 0; i < 5; i += 1) {
      runtime.live.pushFrame(new Float32Array(RATE / 2).fill(0.25), RATE);
    }
    await vi.waitFor(() => {
      expect(updates.at(-1)?.committedText).toBe('[00:00.00-00:01.90] uno dos tres cuatro');
    });
    // Before the phrase ended its words were on screen and not yet committed.
    const rewriting = updates.find((update) => update.displayText.endsWith('uno dos'));
    expect(rewriting?.committedText).toBe('');
    const text = await runtime.live.stop();
    expect(text).toBe('[00:00.00-00:01.90] uno dos tres cuatro\n[00:02.00-00:02.40] uno');
    // Nothing was lost, so the draft is the transcript and the pass after Stop can be skipped.
    expect(runtime.live.lastDraftIsComplete).toBe(true);
    expect(runtime.status.lastLiveDrops).toEqual({ droppedMs: 0, totalMs: 2_500 });
    expect(asked).toEqual(['Deepgram']);
    expect(clients).toEqual([]);
    expect(engine.recognizers).toHaveLength(0);
  });

  it('ElevenLabs streams its live pass too, and uploads the pass after Stop', async () => {
    const { runtime, clients, asked } = await streamingRuntime({ kind: 'ElevenLabs' });
    expect((await runtime.engine()).kind).toBe('ElevenLabs');
    const updates: { committedText: string }[] = [];
    runtime.live.onTranscriptUpdated((update) => updates.push(update));
    await startLive(runtime);
    for (let i = 0; i < 5; i += 1) {
      runtime.live.pushFrame(new Float32Array(RATE / 2).fill(0.25), RATE);
    }
    await vi.waitFor(() => {
      expect(updates.at(-1)?.committedText).toBe('[00:00.00-00:01.90] uno dos tres cuatro');
    });
    await runtime.live.stop();
    expect(asked).toEqual(['ElevenLabs']);
    expect(clients).toEqual([]);
    expect(await offline(runtime)).toBe('[00:00.00-00:01.90] alfa beta gamma delta');
    expect(clients.map((entry) => entry.kind)).toEqual(['ElevenLabs']);
  });

  it('the pass after Stop and an imported file upload the recording, with no session', async () => {
    const { runtime, clients, asked, engine } = await streamingRuntime();
    expect(await offline(runtime)).toBe('[00:00.00-00:01.90] alfa beta gamma delta');
    expect(clients.map((entry) => entry.kind)).toEqual(['Deepgram']);
    expect(clients[0]?.client.requests).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(engine.recognizers).toHaveLength(0);
  });

  it('a key the provider refuses reaches the live failure listeners, and the take keeps recording', async () => {
    const { runtime, failures } = await streamingRuntime({
      streaming: new FakeStreamingSpeechProvider({ failWith: 'KeyInvalid' }),
    });
    await startLive(runtime);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await vi.waitFor(() => {
      expect(failures).toHaveLength(1);
    });
    expect(failures[0]).toMatchObject({ engine: 'Deepgram', error: { kind: 'KeyInvalid' } });
    // The session is over, the live pass is not: later audio is taken and counted as lost.
    expect(runtime.live.isRunning).toBe(true);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    expect(await runtime.live.stop()).toBe('');
    expect(failures).toHaveLength(1);
    expect(runtime.live.lastDraftIsComplete).toBe(false);
    expect(runtime.status.lastLiveDrops).toEqual({ droppedMs: 2_000, totalMs: 2_000 });
  });

  it('an account without credit is told the same way', async () => {
    const { runtime, failures } = await streamingRuntime({
      streaming: new FakeStreamingSpeechProvider({ failWith: 'QuotaExceeded' }),
    });
    await startLive(runtime);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await runtime.live.stop();
    expect(failures).toMatchObject([{ engine: 'Deepgram', error: { kind: 'QuotaExceeded' } }]);
  });

  it('a connection that drops mid-recording says nothing, counts the lost audio, and the pass after Stop uploads', async () => {
    const provider = new ScriptedStreamingSpeechProvider();
    const { runtime, failures, clients } = await streamingRuntime({ streaming: provider });
    await startLive(runtime);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await vi.waitFor(() => {
      expect(provider.sessions).toHaveLength(1);
    });
    const session = provider.sessions[0];
    if (session === undefined) throw new Error('no session was opened');
    session.listener.opened();
    session.listener.final({
      text: 'uno dos',
      words: [
        { text: 'uno', startMs: 0, endMs: 400 },
        { text: 'dos', startMs: 500, endMs: 900 },
      ],
      processedMs: 1_000,
    });
    // One more second reaches the provider, and then the connection is gone.
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await vi.waitFor(() => {
      expect(session.sentSamples).toBe(2 * RATE);
    });
    session.listener.closed(new ApiProviderError('Scripted', 'Network'));
    expect(runtime.live.isRunning).toBe(true);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);

    expect(await runtime.live.stop()).toBe('[00:00.00-00:00.90] uno dos');
    // No notice: waiting may fix a network, and the pass after Stop covers the gap.
    expect(failures).toEqual([]);
    expect(runtime.live.lastDraftIsComplete).toBe(false);
    expect(runtime.status.lastLiveDrops).toEqual({ droppedMs: 2_000, totalMs: 3_000 });
    expect(clients).toEqual([]);
    expect(await offline(runtime)).toBe('[00:00.00-00:01.90] alfa beta gamma delta');
    expect(clients.map((entry) => entry.kind)).toEqual(['Deepgram']);
  });

  it('a session that never opens is given up on the streaming timer, whatever clock paces the uploads', async () => {
    const provider = new ScriptedStreamingSpeechProvider();
    const { runtime, streamingTimer, failures } = await streamingRuntime({ streaming: provider });
    await startLive(runtime);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await vi.waitFor(() => {
      expect(provider.sessions).toHaveLength(1);
    });
    // The upload clock resolves every wait at once; the session is still being waited for.
    expect(provider.sessions[0]?.closed).toBe(false);
    await streamingTimer.advance(STREAMING_OPEN_TIMEOUT_MS);
    expect(provider.sessions[0]?.closed).toBe(true);
    await runtime.live.stop();
    expect(failures).toEqual([]);
    expect(runtime.live.lastDraftIsComplete).toBe(false);
  });

  it('with no streaming provider to build, its live text arrives in pieces through the client', async () => {
    const { runtime, clients } = await streamingRuntime({ streaming: null });
    await startLive(runtime);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    expect(await runtime.live.stop()).toBe('[00:00.00-00:00.90] alfa beta');
    expect(clients.map((entry) => entry.kind)).toEqual(['Deepgram']);
  });

  it('an engine whose live text comes in pieces is never asked for a streaming provider', async () => {
    const { runtime, settings, keys, asked, clients } = await streamingRuntime();
    await keys.set('Groq', 'gsk-test');
    await settings.update({ transcriptionEngine: 'Groq' });
    await startLive(runtime);
    runtime.live.pushFrame(new Float32Array(RATE).fill(0.25), RATE);
    await runtime.live.stop();
    expect(asked).toEqual([]);
    expect(clients.map((entry) => entry.kind)).toEqual(['Groq']);
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
