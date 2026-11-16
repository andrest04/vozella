import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyKind } from '../api-keys/api-key-store';
import { CancelSource } from '../cancel';
import { ApiProviderError } from '../summaries/api-failure';
import { CloudRequestPacer, CLOUD_MIN_REQUEST_INTERVAL_MS } from './cloud-speech-engine';
import { StreamingSpeechEngineProvider } from './speech-engine-provider';
import { STREAMING_OPEN_TIMEOUT_MS } from './streaming-speech-engine';
import {
  FakeSpeechTimer,
  ManualSpeechTimer,
  ScriptedSpeechToTextClient,
  ScriptedStreamingSpeechProvider,
} from './test-kit';

const RATE = 1000;
const audio = (durationMs: number): Float32Array =>
  new Float32Array((durationMs * RATE) / 1000).fill(0.5);

function setup(options: { keys?: readonly ApiKeyKind[]; streaming?: boolean } = {}) {
  const streaming = new ScriptedStreamingSpeechProvider();
  const recorded = new ScriptedSpeechToTextClient();
  // The uploads are paced on a clock that never sleeps; a session waits on one that really waits.
  const timer = new FakeSpeechTimer();
  const streamingTimer = new ManualSpeechTimer();
  const lost: { error: unknown; lostMs: number }[] = [];
  const streamings = vi.fn(() => (options.streaming === false ? null : streaming));
  const clients = vi.fn(() => recorded);
  const keys = options.keys ?? ['Deepgram'];
  const provider = new StreamingSpeechEngineProvider({
    kind: 'Deepgram',
    keys: { has: (kind) => Promise.resolve(keys.includes(kind)) },
    streaming: streamings,
    client: clients,
    timer,
    streamingTimer,
    pacer: new CloudRequestPacer(),
    onLost: (error, lostMs) => lost.push({ error, lostMs }),
  });
  return { provider, streaming, recorded, streamings, clients, timer, streamingTimer, lost };
}

const stream = async (
  provider: StreamingSpeechEngineProvider,
  latency: 'live' | 'offline' | undefined,
) => {
  const created = await provider.create(latency === undefined ? {} : { latency });
  const opened = await created.recognizer.startStream({
    language: 'es-US',
    interimResults: true,
    diarization: false,
  });
  return { created, stream: opened };
};

describe('StreamingSpeechEngineProvider', () => {
  it('is the cloud kind it was given, ready when the key of that kind is stored', async () => {
    const { provider } = setup();
    expect(provider.kind).toBe('Deepgram');
    expect(await provider.isReady()).toBe(true);
    expect(await setup({ keys: ['Groq'] }).provider.isReady()).toBe(false);
  });

  it('builds nothing until a pass starts', async () => {
    const { provider, streamings, clients } = setup();
    await provider.isReady();
    expect(streamings).not.toHaveBeenCalled();
    expect(clients).not.toHaveBeenCalled();
  });

  it('a live pass goes to the streaming session, word by word, and never uploads', async () => {
    const { provider, streaming, recorded, clients } = setup();
    const live = await stream(provider, 'live');
    expect(live.created.diarization).toBe(false);
    await live.stream.push(audio(500), RATE);
    const session = streaming.sessions[0];
    if (session === undefined) throw new Error('no session was opened');
    session.listener.opened();
    session.listener.interim({
      text: 'hola',
      words: [{ text: 'hola', startMs: 0, endMs: 400 }],
      processedMs: 500,
    });
    expect(await live.stream.pullAvailable()).toMatchObject([
      { isFinal: false, transcript: 'hola' },
    ]);
    expect(session.sentSamples).toBe(500);
    expect(clients).not.toHaveBeenCalled();
    expect(recorded.requests).toEqual([]);
  });

  it('live is the profile of a pass that names none', async () => {
    const { provider, streaming } = setup();
    const pass = await stream(provider, undefined);
    await pass.stream.push(audio(100), RATE);
    expect(streaming.sessions).toHaveLength(1);
  });

  it('an offline pass uploads the recording through the client and opens no session', async () => {
    const { provider, streaming, streamings, recorded } = setup();
    const offline = await stream(provider, 'offline');
    expect(offline.created.diarization).toBe(false);
    await offline.stream.push(audio(2_000), RATE);
    await offline.stream.drain?.();
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0]?.samples).toHaveLength(2_000);
    expect(await offline.stream.pullAvailable()).toMatchObject([{ transcript: 'piece0' }]);
    expect(streamings).not.toHaveBeenCalled();
    expect(streaming.sessions).toEqual([]);
  });

  it('offline passes keep the request pacing of the provider', async () => {
    const { provider, timer } = setup();
    for (let pass = 0; pass < 2; pass += 1) {
      const offline = await stream(provider, 'offline');
      await offline.stream.push(audio(1_000), RATE);
      await offline.stream.drain?.();
    }
    expect(timer.waits).toEqual([CLOUD_MIN_REQUEST_INTERVAL_MS]);
  });

  it('a live session that fails tells the same listener as a failed upload', async () => {
    const { provider, streaming, lost } = setup();
    const live = await stream(provider, 'live');
    await live.stream.push(audio(300), RATE);
    const refused = new ApiProviderError('Scripted', 'KeyInvalid');
    streaming.sessions[0]?.listener.closed(refused);
    expect(lost).toEqual([{ error: refused, lostMs: 300 }]);
    expect((await live.stream.drain?.())?.lostMs).toBe(300);
  });

  it('a session that never opens is given up on the streaming timer, not the upload clock', async () => {
    const { provider, streaming, streamingTimer, timer, lost } = setup();
    const live = await stream(provider, 'live');
    await live.stream.push(audio(200), RATE);
    await streamingTimer.advance(STREAMING_OPEN_TIMEOUT_MS - 1);
    expect(lost).toEqual([]);
    await streamingTimer.advance(1);
    expect(lost).toMatchObject([{ error: { kind: 'TimedOut' }, lostMs: 200 }]);
    expect(streaming.sessions[0]?.closed).toBe(true);
    expect(timer.waits).toEqual([]);
  });

  it('the cancel of a live pass ends its session', async () => {
    const { provider, streaming } = setup();
    const cancel = new CancelSource();
    const created = await provider.create({ latency: 'live', cancel: cancel.signal });
    const live = await created.recognizer.startStream({
      language: 'es-US',
      interimResults: true,
      diarization: false,
    });
    await live.push(audio(100), RATE);
    cancel.cancel();
    expect(streaming.sessions[0]?.closed).toBe(true);
  });

  it('without a streaming provider the live pass falls back to pieces through the client', async () => {
    const { provider, recorded } = setup({ streaming: false });
    const live = await stream(provider, 'live');
    await live.stream.push(audio(1_000), RATE);
    await live.stream.drain?.();
    expect(recorded.requests).toHaveLength(1);
  });
});
