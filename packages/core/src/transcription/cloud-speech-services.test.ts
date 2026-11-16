import { describe, expect, it, vi } from 'vitest';
import { CancelSource, type CancelSignal } from '../cancel';
import type { ApiKeyKind } from '../api-keys/api-key-store';
import { ApiProviderError } from '../summaries/api-failure';
import { AsrBackendStatus } from './backend-status';
import { CLOUD_LIVE_CHUNK_TARGET_MS } from './cloud-speech-engine';
import {
  LIVE_QUEUE_CAPACITY,
  LIVE_STOP_DEADLINE_MS,
  LiveTranscriptionService,
} from './live-service';
import { MicActivityTimeline } from './mic-activity';
import { TranscriptionService } from './offline-service';
import { TranscriptionCancelledError } from './ports';
import { NemoSpeechRecognizerFactory } from './recognizer-factory';
import { CloudSpeechEngineProvider, LocalSpeechEngineProvider } from './speech-engine-provider';
import {
  FakeAsrEngine,
  FakeAudioReader,
  FakeModelStore,
  FakeRuntimeStore,
  FakeSpeechTimer,
  ManualSpeechTimer,
  ScriptedSpeechToTextClient,
} from './test-kit';

const RATE = 16_000;
const seconds = (count: number): Float32Array => new Float32Array(count * RATE).fill(0.25);

function cloud(keys: readonly ApiKeyKind[] = ['Groq']) {
  const client = new ScriptedSpeechToTextClient();
  const timer = new FakeSpeechTimer();
  const lost: unknown[] = [];
  const clients = vi.fn(() => client);
  const provider = new CloudSpeechEngineProvider({
    kind: 'Groq',
    keys: { has: (kind) => Promise.resolve(keys.includes(kind)) },
    client: clients,
    timer,
    onLost: (error) => lost.push(error),
  });
  return { client, clients, timer, lost, provider };
}

function local() {
  const engine = new FakeAsrEngine();
  const models = new FakeModelStore();
  const runtimes = new FakeRuntimeStore();
  const factory = new NemoSpeechRecognizerFactory({
    engine,
    models,
    runtimes,
    hardware: () => Promise.resolve({ gpuName: null }),
  });
  const installer = { isReady: () => models.model && runtimes.ready.has('cpu') };
  return {
    engine,
    models,
    runtimes,
    factory,
    provider: new LocalSpeechEngineProvider({ installer, factory }),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
};

/** Lets held uploads go one by one until `done` settles. */
async function releasing<T>(client: ScriptedSpeechToTextClient, done: Promise<T>): Promise<T> {
  const state = { settled: false };
  const marked = done.finally(() => {
    state.settled = true;
  });
  marked.catch(() => undefined);
  for (let i = 0; i < 200 && !state.settled; i += 1) {
    await settle();
    client.release();
  }
  return marked;
}

/** Waits for something the services do on their own time. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) await settle();
  expect(condition()).toBe(true);
}

/**
 * Feeds `totalSeconds` of audio as the capture does: 200 ms frames, one at a time, so the frame
 * queue is emptied between them as it is in a recording.
 */
async function feed(live: LiveTranscriptionService, totalSeconds: number): Promise<void> {
  const frame = new Float32Array(RATE / 5).fill(0.25);
  for (let i = 0; i < totalSeconds * 5; i += 1) {
    live.pushFrame(frame, RATE);
    await settle();
  }
}

describe('speech engine providers', () => {
  it('local: ready follows the installed engine and passes go to the local factory', async () => {
    const { models, runtimes, provider, engine } = local();
    expect(provider.kind).toBe('Local');
    expect(await provider.isReady()).toBe(false);
    models.model = true;
    runtimes.ready.add('cpu');
    expect(await provider.isReady()).toBe(true);
    await provider.create({ latency: 'offline' });
    expect(engine.recognizers).toHaveLength(1);
    expect(engine.recognizers[0]?.settings.latency).toBe('offline');
  });

  it('cloud: ready when the key of that provider is stored, with nothing to install', async () => {
    expect(await cloud(['Groq']).provider.isReady()).toBe(true);
    expect(await cloud([]).provider.isReady()).toBe(false);
    // Another provider's key is not this provider's key.
    expect(await cloud(['OpenAi']).provider.isReady()).toBe(false);
    expect(cloud().provider.kind).toBe('Groq');
  });

  it('cloud: speaker labels are off whatever the pass asks for', async () => {
    const { provider } = cloud();
    const created = await provider.create({ enableDiarization: true, latency: 'live' });
    expect(created.diarization).toBe(false);
  });

  it('cloud: builds its client when a pass starts, one per pass', async () => {
    const { provider, clients } = cloud();
    expect(clients).not.toHaveBeenCalled();
    await provider.create({ latency: 'live' });
    await provider.create({ latency: 'offline' });
    expect(clients).toHaveBeenCalledTimes(2);
  });
});

describe('offline pass over a cloud engine', () => {
  it('transcribes the tail when the file ends and waits for it before finishing', async () => {
    const { client, provider } = cloud();
    const audio = new FakeAudioReader(seconds(25));
    const progress: number[] = [];
    const text = await new TranscriptionService({ factory: provider, audio }).transcribe({
      audioPath: 'C:/a.wav',
      language: 'es',
      recordedAtMs: null,
      speakerDiarization: false,
      onProgress: (percent) => progress.push(percent),
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.samples.length).toBe(25 * RATE);
    expect(client.requests[0]?.language).toBe('es-US');
    expect(text).toBe('[00:00.10-00:00.20] piece0');
    expect(progress.at(-1)).toBe(100);
  });

  it('stamps every piece of a long file at its place in the recording', async () => {
    const { client, provider } = cloud();
    const audio = new FakeAudioReader(seconds(130));
    const text = await new TranscriptionService({ factory: provider, audio }).transcribe({
      audioPath: 'C:/a.wav',
      language: 'es',
      recordedAtMs: null,
      speakerDiarization: false,
    });
    expect(client.maxInFlight).toBe(1);
    expect(client.requests.map((request) => request.samples.length / RATE)).toEqual([60, 60, 10]);
    expect(text.split('\n')).toEqual([
      '[00:00.10-00:00.20] piece0',
      '[01:00.10-01:00.20] piece1',
      '[02:00.10-02:00.20] piece2',
    ]);
  });

  it('a failed piece fails the pass with the API failure, and closes the stream', async () => {
    const { client, provider } = cloud();
    client.errors = [new ApiProviderError('Groq', 'KeyInvalid')];
    const audio = new FakeAudioReader(seconds(5));
    const run = new TranscriptionService({ factory: provider, audio }).transcribe({
      audioPath: 'C:/a.wav',
      language: 'es',
      recordedAtMs: null,
      speakerDiarization: false,
    });
    await expect(run).rejects.toBeInstanceOf(ApiProviderError);
    await expect(run).rejects.toMatchObject({ kind: 'KeyInvalid', displayName: 'Groq' });
    expect(audio.closed).toBe(1);
  });

  it('cancel aborts the upload in flight', async () => {
    const { client, provider } = cloud();
    client.hold();
    const cancel = new CancelSource();
    const audio = new FakeAudioReader(seconds(130));
    const run = new TranscriptionService({ factory: provider, audio }).transcribe({
      audioPath: 'C:/a.wav',
      language: 'es',
      recordedAtMs: null,
      speakerDiarization: false,
      cancel: cancel.signal,
    });
    run.catch(() => undefined);
    await until(() => client.inFlight === 1);
    cancel.cancel();
    await expect(run).rejects.toBeInstanceOf(TranscriptionCancelledError);
    expect(client.cancels[0]?.cancelled).toBe(true);
    expect(client.requests).toHaveLength(1);
  });

  it('speaker labels stay off: no Speaker or You label even with the switch on', async () => {
    const { provider } = cloud();
    const micActivity = {
      read: vi.fn(() => new MicActivityTimeline([{ startMs: 0, endMs: 60_000 }])),
    };
    const audio = new FakeAudioReader(seconds(5));
    const text = await new TranscriptionService({
      factory: provider,
      audio,
      micActivity,
    }).transcribe({
      audioPath: 'C:/a.wav',
      language: 'es',
      recordedAtMs: null,
      speakerDiarization: true,
    });
    expect(text).toBe('[00:00.10-00:00.20] piece0');
    expect(micActivity.read).not.toHaveBeenCalled();
  });
});

describe('live pass over a cloud engine', () => {
  it('stop transcribes the tail and waits for it, and the draft is complete', async () => {
    const { client, provider } = cloud();
    const live = new LiveTranscriptionService({ factory: provider });
    const updates: string[] = [];
    live.onTranscriptUpdated((update) => updates.push(update.committedText));
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: true });
    await feed(live, 3);
    await settle();
    expect(client.requests).toHaveLength(0);
    const text = await live.stop();
    expect(client.requests).toHaveLength(1);
    expect(text).toBe('[00:00.10-00:00.20] piece0');
    expect(updates.at(-1)).toBe(text);
    expect(live.lastDraftIsComplete).toBe(true);
  });

  it('shows each piece as it comes back while recording', async () => {
    const { provider } = cloud();
    const live = new LiveTranscriptionService({ factory: provider });
    const updates: string[] = [];
    live.onTranscriptUpdated((update) => updates.push(update.committedText));
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await feed(live, CLOUD_LIVE_CHUNK_TARGET_MS / 1000 + 1);
    await settle();
    // One more frame lets the loop pull the result of the piece that came back.
    await feed(live, 1);
    await settle();
    expect(updates.at(-1)).toBe('[00:00.10-00:00.20] piece0');
    await live.stop();
  });

  it('uploads slower than real time drop nothing: the audio waits in the engine', async () => {
    const { client, provider } = cloud();
    const status = new AsrBackendStatus();
    const live = new LiveTranscriptionService({ factory: provider, status });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    client.hold();
    // Far more frames than the frame queue holds, while the first upload is still out.
    await feed(live, 40);
    expect(40 * 5).toBeGreaterThan(LIVE_QUEUE_CAPACITY);
    await settle();
    expect(client.inFlight).toBe(1);
    const text = await releasing(client, live.stop());
    const sent = client.requests.reduce((sum, request) => sum + request.samples.length, 0);
    expect(sent).toBe(40 * RATE);
    expect(text.split('\n')).toHaveLength(client.requests.length);
    expect(status.lastLiveDrops).toEqual({ droppedMs: 0, totalMs: 40_000 });
    expect(live.lastDraftIsComplete).toBe(true);
  });

  it('a piece that failed is a recorded gap: the draft is not complete', async () => {
    const { client, provider, lost } = cloud();
    const status = new AsrBackendStatus();
    const live = new LiveTranscriptionService({ factory: provider, status });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    client.errors = [new ApiProviderError('Groq', 'Unknown', 'boom')];
    await feed(live, 16);
    await settle();
    await feed(live, 4);
    const text = await live.stop();
    expect(lost).toHaveLength(1);
    // The transcript looks whole, so the gap is carried beside it.
    expect(text).toBe('[00:15.10-00:15.20] piece1');
    expect(live.lastDraftIsComplete).toBe(false);
    expect(status.lastLiveDrops).toEqual({ droppedMs: 15_000, totalMs: 20_000 });
  });

  it('a failure waiting cannot fix ends the uploads; the recording goes on', async () => {
    const { client, provider } = cloud();
    const live = new LiveTranscriptionService({ factory: provider });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    client.errors = [new ApiProviderError('Groq', 'QuotaExceeded')];
    await feed(live, 16);
    await settle();
    await feed(live, 30);
    expect(await live.stop()).toBe('');
    expect(client.requests).toHaveLength(1);
    expect(live.lastDraftIsComplete).toBe(false);
  });

  it('a new session forgets the result of the one before', async () => {
    const { provider } = cloud();
    const live = new LiveTranscriptionService({ factory: provider });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await feed(live, 2);
    await live.stop();
    expect(live.lastDraftIsComplete).toBe(true);
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    expect(live.lastDraftIsComplete).toBe(false);
    await live.stop();
  });

  it('a Stop with no session forgets the draft of the take before it', async () => {
    const { provider } = cloud();
    const live = new LiveTranscriptionService({ factory: provider });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await feed(live, 2);
    await live.stop();
    expect(live.lastDraftIsComplete).toBe(true);
    // The next take runs with live transcription off: its Stop finds no session.
    expect(await live.stop()).toBe('');
    expect(live.lastDraftIsComplete).toBe(false);
  });

  it('the punctuation of the provider reaches the stamped lines of a long piece', async () => {
    const { client, provider } = cloud();
    client.answer = (_call, request) => ({
      text: 'Buenos días, equipo. Empezamos ya.',
      words: [
        { text: 'buenos', startMs: 0, endMs: 400 },
        { text: 'días', startMs: 500, endMs: 900 },
        { text: 'equipo', startMs: 1_000, endMs: 1_400 },
        // More than 30 s later: the piece cannot be one line, so the lines come from the words.
        { text: 'empezamos', startMs: 40_000, endMs: 40_400 },
        { text: 'ya', startMs: 40_500, endMs: 40_900 },
      ],
      durationMs: (request.samples.length * 1000) / request.sampleRate,
    });
    const audio = new FakeAudioReader(seconds(45));
    const text = await new TranscriptionService({ factory: provider, audio }).transcribe({
      audioPath: 'C:/a.wav',
      language: 'es',
      recordedAtMs: null,
      speakerDiarization: false,
    });
    expect(text.split('\n')).toEqual([
      '[00:00.00-00:01.40] Buenos días, equipo.',
      '[00:40.00-00:40.90] Empezamos ya.',
    ]);
  });

  it('the local engine never vouches for its draft: the pass after Stop still runs', async () => {
    const { models, runtimes, provider, engine } = local();
    models.model = true;
    runtimes.ready.add('cpu');
    engine.script = {
      afterPush: [
        [
          {
            isFinal: true,
            transcript: 'hola',
            audioProcessedSeconds: 1,
            words: [{ startMs: 0, endMs: 1000, speakerTag: 0, text: null }],
          },
        ],
      ],
    };
    const live = new LiveTranscriptionService({ factory: provider });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await feed(live, 1);
    expect(await live.stop()).toBe('[00:00.00-00:01.00] hola');
    expect(live.lastDraftIsComplete).toBe(false);
  });
});

/** The stop deadline as a wait the test ends by hand, as the app's timer ends it after the time. */
function stopDeadline() {
  const state: { requestedMs: number | null; released: boolean; elapse: () => void } = {
    requestedMs: null,
    released: false,
    elapse: () => undefined,
  };
  const wait = (ms: number, cancel: CancelSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      state.requestedMs = ms;
      state.elapse = resolve;
      cancel.onCancel(() => {
        state.released = true;
        resolve();
      });
    });
  return { state, wait };
}

/** Starts Stop and reports the draft once it has one, without waiting for it. */
function stopping(live: LiveTranscriptionService) {
  const state: { draft: string | null } = { draft: null };
  void live.stop().then((draft) => {
    state.draft = draft;
  });
  return state;
}

describe('Stop with a cloud engine that is behind', () => {
  it('waits for the uploads no longer than the deadline, then cancels them', async () => {
    const { client, provider } = cloud();
    const status = new AsrBackendStatus();
    const deadline = stopDeadline();
    const errors: unknown[] = [];
    const live = new LiveTranscriptionService({
      factory: provider,
      status,
      stopWait: deadline.wait,
      onError: (error) => errors.push(error),
    });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    client.hold();
    await feed(live, 40);
    const stop = stopping(live);
    await settle();
    // The upload is stalled: Stop is waiting, with the deadline running.
    expect(stop.draft).toBeNull();
    expect(deadline.state.requestedMs).toBe(LIVE_STOP_DEADLINE_MS);
    expect(LIVE_STOP_DEADLINE_MS).toBe(25_000);

    deadline.state.elapse();
    await settle();
    expect(stop.draft).toBe('');
    expect(client.cancels[0]?.cancelled).toBe(true);
    expect(client.requests).toHaveLength(1);
    expect(live.lastDraftIsComplete).toBe(false);
    // Nothing of the take was transcribed, and the status says so.
    expect(status.lastLiveDrops).toEqual({ droppedMs: 40_000, totalMs: 40_000 });
    expect(errors).toHaveLength(1);
  });

  it('a draft whose last pieces were cut off at the deadline is not complete', async () => {
    const { client, provider } = cloud();
    const status = new AsrBackendStatus();
    const deadline = stopDeadline();
    const live = new LiveTranscriptionService({
      factory: provider,
      status,
      stopWait: deadline.wait,
    });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await feed(live, 16);
    await settle();
    client.hold();
    await feed(live, 20);
    const stop = stopping(live);
    await settle();
    deadline.state.elapse();
    await settle();
    // The draft has text and looks whole, but 21 s of the take never came back: the pass after
    // Stop must run.
    expect(stop.draft).toBe('[00:00.10-00:00.20] piece0');
    expect(live.lastDraftIsComplete).toBe(false);
    expect(status.lastLiveDrops).toEqual({ droppedMs: 21_000, totalMs: 36_000 });
  });

  it('stays prompt when the client never answers', async () => {
    const { client, provider } = cloud();
    const deadline = stopDeadline();
    const live = new LiveTranscriptionService({ factory: provider, stopWait: deadline.wait });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    client.transcribe = () => new Promise<never>(() => undefined);
    await feed(live, 3);
    const stop = stopping(live);
    await settle();
    expect(stop.draft).toBeNull();
    deadline.state.elapse();
    await settle();
    expect(stop.draft).toBe('');
    expect(live.lastDraftIsComplete).toBe(false);
  });

  it('wins over a rate limit that asked the engine to hold its requests', async () => {
    const client = new ScriptedSpeechToTextClient();
    const deadline = stopDeadline();
    // A clock that does not move: the hold lasts until something cancels it.
    const provider = new CloudSpeechEngineProvider({
      kind: 'Groq',
      keys: { has: () => Promise.resolve(true) },
      client: () => client,
      timer: new ManualSpeechTimer(),
    });
    const live = new LiveTranscriptionService({ factory: provider, stopWait: deadline.wait });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    client.errors = [new ApiProviderError('Groq', 'RateLimited', null, undefined, 30 * 60_000)];
    await feed(live, 16);
    await settle();
    expect(client.requests).toHaveLength(1);
    const stop = stopping(live);
    await settle();
    expect(stop.draft).toBeNull();
    deadline.state.elapse();
    await settle();
    expect(stop.draft).toBe('');
    expect(client.requests).toHaveLength(1);
    expect(live.lastDraftIsComplete).toBe(false);
  });

  it('a Stop that ends in time is not cut, and releases the deadline', async () => {
    const { client, provider } = cloud();
    const deadline = stopDeadline();
    const errors: unknown[] = [];
    const live = new LiveTranscriptionService({
      factory: provider,
      stopWait: deadline.wait,
      onError: (error) => errors.push(error),
    });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await feed(live, 3);
    expect(await live.stop()).toBe('[00:00.10-00:00.20] piece0');
    expect(deadline.state.released).toBe(true);
    expect(client.requests).toHaveLength(1);
    expect(live.lastDraftIsComplete).toBe(true);
    // A deadline that elapses after the Stop is over does nothing.
    deadline.state.elapse();
    await settle();
    expect(errors).toEqual([]);
  });

  it('the local engine has nothing to drain: no deadline is started for it', async () => {
    const { models, runtimes, provider } = local();
    models.model = true;
    runtimes.ready.add('cpu');
    const deadline = stopDeadline();
    const live = new LiveTranscriptionService({ factory: provider, stopWait: deadline.wait });
    await live.start({ language: 'es', recordedAtMs: null, speakerDiarization: false });
    await feed(live, 1);
    await live.stop();
    expect(deadline.state.requestedMs).toBeNull();
  });
});
