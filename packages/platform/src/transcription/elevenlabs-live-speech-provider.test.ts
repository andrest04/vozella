import {
  ApiProviderError,
  CancelSource,
  ManualSpeechTimer,
  type ApiFailureKind,
  type CancelSignal,
  type StreamingSpeechListener,
  type StreamingSpeechResult,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { ScriptedLiveSockets, type ScriptedLiveSocket } from '../fakes/scripted-live-socket';
import {
  ELEVENLABS_CHUNK_MS,
  ELEVENLABS_COMMIT_AFTER_MS,
  ELEVENLABS_FINISH_TIMEOUT_MS,
  ELEVENLABS_FORCED_COMMIT_MS,
  ELEVENLABS_IDLE_SILENCE_MS,
  ELEVENLABS_PLAIN_HOLD_MS,
  ElevenLabsLiveSpeechProvider,
} from './elevenlabs-live-speech-provider';
import { ELEVENLABS_BASE_URL } from './elevenlabs-scribe';

const KEY = 'xi-live-secret-0123456789';
const RATE = 16_000;
const LOUD = 0.5;

type Heard =
  | { readonly event: 'opened' }
  | { readonly event: 'interim' | 'final'; readonly result: StreamingSpeechResult }
  | { readonly event: 'closed'; readonly error: ApiProviderError | null };

interface Chunk {
  readonly message_type: string;
  readonly audio_base_64: string;
  readonly commit: boolean;
  readonly sample_rate: number;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

interface Setup {
  readonly key?: string | null;
  readonly language?: string;
  readonly sampleRate?: number;
  readonly keyCheck?: ApiFailureKind | null;
  readonly cancel?: CancelSignal;
}

async function start(setup: Setup = {}) {
  const sockets = new ScriptedLiveSockets();
  const timer = new ManualSpeechTimer();
  const heard: Heard[] = [];
  const keyChecks: string[] = [];
  const key = setup.key === undefined ? KEY : setup.key;
  const provider = new ElevenLabsLiveSpeechProvider({
    displayName: 'ElevenLabs',
    baseUrl: ELEVENLABS_BASE_URL,
    model: 'scribe_v2_realtime',
    apiKey: () => Promise.resolve(key),
    timer,
    socket: sockets.factory,
    checkKey: (checked) => {
      keyChecks.push(checked);
      const kind = setup.keyCheck ?? null;
      return kind === null
        ? Promise.resolve()
        : Promise.reject(new ApiProviderError('ElevenLabs', kind));
    },
  });
  const listener: StreamingSpeechListener = {
    opened: () => heard.push({ event: 'opened' }),
    interim: (result) => heard.push({ event: 'interim', result }),
    final: (result) => heard.push({ event: 'final', result }),
    closed: (error) => heard.push({ event: 'closed', error }),
  };
  const session = provider.open(
    {
      language: setup.language ?? 'es-US',
      sampleRate: setup.sampleRate ?? RATE,
      cancel: setup.cancel ?? new CancelSource().signal,
    },
    listener,
  );
  await settle();
  const socket = (): ScriptedLiveSocket => {
    const first = sockets.sockets[0];
    if (first === undefined) throw new Error('no socket was opened');
    return first;
  };
  const closedWith = (): ApiProviderError | null | undefined => {
    const last = heard.at(-1);
    return last?.event === 'closed' ? last.error : undefined;
  };
  const chunks = (): Chunk[] =>
    socket().sent.flatMap((frame) =>
      typeof frame === 'string' ? [JSON.parse(frame) as Chunk] : [],
    );
  const results = () =>
    heard.filter((entry) => entry.event === 'interim' || entry.event === 'final');
  return {
    provider,
    sockets,
    socket,
    timer,
    heard,
    keyChecks,
    session,
    closedWith,
    chunks,
    results,
  };
}

/** A session the server has started. */
async function started(setup: Setup = {}) {
  const made = await start(setup);
  made.socket().open();
  made.socket().message({ message_type: 'session_started', session_id: 's', config: {} });
  return made;
}

/** `ms` of audio at 16 kHz with every sample at `value`. */
const tone = (ms: number, value = LOUD, rate = RATE): Float32Array =>
  new Float32Array(Math.round((ms * rate) / 1000)).fill(value);

/** Sends `ms` of audio in 20 ms frames, as the capture does. */
function speak(session: { send(samples: Float32Array): void }, ms: number, value = LOUD): void {
  for (let sent = 0; sent < ms; sent += 20) session.send(tone(Math.min(20, ms - sent), value));
}

const pcm = (chunk: Chunk): number[] => {
  const bytes = Buffer.from(chunk.audio_base_64, 'base64');
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => bytes.readInt16LE(i * 2));
};

const word = (text: string, startS: number, endS: number) => ({
  text,
  start: startS,
  end: endS,
  type: 'word',
  logprob: -0.1,
});

const spacing = (startS: number) => ({ text: ' ', start: startS, end: startS, type: 'spacing' });

describe('ElevenLabsLiveSpeechProvider: opening', () => {
  it('opens the realtime socket with manual commits, timestamps and the xi-api-key header', async () => {
    const { sockets, socket } = await start();
    expect(sockets.sockets).toHaveLength(1);
    const url = new URL(socket().url);
    expect(url.origin + url.pathname).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      commit_strategy: 'manual',
      include_timestamps: 'true',
      language_code: 'es',
    });
    expect(socket().headers).toEqual({ 'xi-api-key': KEY });
    expect(socket().url).not.toContain(KEY);
    expect(socket().binaryType).toBe('arraybuffer');
  });

  it('asks for no language when it is auto', async () => {
    const { socket } = await start({ language: 'auto' });
    expect(new URL(socket().url).searchParams.has('language_code')).toBe(false);
  });

  it('opens only at session_started, not at the socket open', async () => {
    const { socket, heard } = await start();
    socket().open();
    expect(heard).toEqual([]);
    socket().message({ message_type: 'session_started', session_id: 's', config: {} });
    expect(heard).toEqual([{ event: 'opened' }]);
    socket().message({ message_type: 'session_started', session_id: 's', config: {} });
    expect(heard).toEqual([{ event: 'opened' }]);
  });

  it('names the provider', async () => {
    expect((await start()).provider.displayName).toBe('ElevenLabs');
  });

  it.each([null, '', '  '])('fails as KeyMissing without a key (%j)', async (key) => {
    const { sockets, heard } = await start({ key });
    expect(sockets.sockets).toHaveLength(0);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ event: 'closed', error: { kind: 'KeyMissing' } });
  });
});

describe('ElevenLabsLiveSpeechProvider: audio chunks', () => {
  it('sends 250 ms JSON chunks of base64 16-bit PCM, without a commit', async () => {
    const { session, chunks } = await started();
    const first = tone(100);
    first.set([0, 0.5, -0.5, 1, -1, 2, Number.NaN]);
    session.send(first);
    session.send(tone(100));
    expect(chunks()).toEqual([]);
    session.send(tone(100));
    expect(ELEVENLABS_CHUNK_MS).toBe(250);
    expect(chunks()).toHaveLength(1);
    const chunk = chunks()[0];
    if (chunk === undefined) throw new Error('no chunk');
    expect(chunk).toMatchObject({
      message_type: 'input_audio_chunk',
      commit: false,
      sample_rate: 16_000,
    });
    const values = pcm(chunk);
    expect(values).toHaveLength(4000);
    expect(values.slice(0, 7)).toEqual([0, 16384, -16384, 32767, -32768, 32767, 0]);
    expect(values[3999]).toBe(16384);
  });

  it('sends nothing before session_started', async () => {
    const { session, socket } = await start();
    socket().open();
    session.send(tone(300));
    expect(socket().sent).toEqual([]);
  });

  it('resamples another rate to 16 kHz', async () => {
    const { session, chunks } = await started({ sampleRate: 48_000 });
    // A ramp: every third sample of it is what 16 kHz keeps.
    const ramp = Float32Array.from({ length: 12_000 }, (_, i) => (i % 300) / 1000);
    session.send(ramp.subarray(0, 5_000));
    session.send(ramp.subarray(5_000));
    expect(chunks()).toHaveLength(1);
    const values = pcm(chunks()[0] ?? ({} as Chunk));
    expect(values).toHaveLength(4000);
    const expected = Array.from({ length: 4000 }, (_, i) =>
      Math.round(Math.fround(((i * 3) % 300) / 1000) * 32768),
    );
    expect(values).toEqual(expected);
  });
});

describe('ElevenLabsLiveSpeechProvider: commits', () => {
  it('commits at the first quiet chunk once 20 s are uncommitted', async () => {
    const { session, chunks } = await started();
    expect(ELEVENLABS_COMMIT_AFTER_MS).toBe(20_000);
    // Quiet audio before 20 s does not commit.
    speak(session, 1_000, 0);
    speak(session, 19_000);
    expect(chunks().some((chunk) => chunk.commit)).toBe(false);
    speak(session, 500);
    expect(chunks().some((chunk) => chunk.commit)).toBe(false);
    speak(session, 250, 0.001);
    const commits = chunks().flatMap((chunk, i) => (chunk.commit ? [i] : []));
    expect(commits).toEqual([82]);
  });

  it('forces a commit at 25 s of speech with no quiet chunk', async () => {
    const { session, chunks } = await started();
    expect(ELEVENLABS_FORCED_COMMIT_MS).toBe(25_000);
    speak(session, 30_000);
    const commits = chunks().flatMap((chunk, i) => (chunk.commit ? [i] : []));
    expect(commits).toEqual([99]);
  });
});

describe('ElevenLabsLiveSpeechProvider: results', () => {
  it('turns a partial into an interim with words spread over the uncommitted audio', async () => {
    const { session, socket, results } = await started();
    speak(session, 1_000);
    socket().message({ message_type: 'partial_transcript', text: ' Hola a  todos ' });
    expect(results()).toEqual([
      {
        event: 'interim',
        result: {
          text: 'Hola a  todos',
          words: [
            { text: 'Hola', startMs: 0, endMs: 333 },
            { text: 'a', startMs: 333, endMs: 667 },
            { text: 'todos', startMs: 667, endMs: 1000 },
          ],
          processedMs: 1000,
        },
      },
    ]);
  });

  it('withdraws the interim at an empty partial', async () => {
    const { session, socket, results } = await started();
    speak(session, 500);
    socket().message({ message_type: 'partial_transcript', text: '' });
    expect(results()).toEqual([
      { event: 'interim', result: { text: '', words: [], processedMs: 500 } },
    ]);
  });

  it('reads a timestamped commit as a final covering the audio up to its commit', async () => {
    const { session, socket, results } = await started();
    speak(session, 20_000);
    speak(session, 250, 0);
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'Hola todos.',
      language_code: 'es',
      words: [word('Hola', 0.1, 0.4), spacing(0.4), word('todos.', 0.5, 0.9)],
    });
    expect(results()).toEqual([
      {
        event: 'final',
        result: {
          text: 'Hola todos.',
          words: [
            { text: 'Hola', startMs: 100, endMs: 400 },
            { text: 'todos.', startMs: 500, endMs: 900 },
          ],
          processedMs: 20_250,
        },
      },
    ]);
  });

  it('places the words of a later segment on the session clock, whichever clock they use', async () => {
    const { session, socket, results } = await started();
    speak(session, 20_000);
    speak(session, 250, 0); // commit 1 at 20 250
    socket().message({ message_type: 'committed_transcript_with_timestamps', text: '', words: [] });
    speak(session, 20_000);
    speak(session, 250, 0); // commit 2 at 40 500
    speak(session, 20_000);
    speak(session, 250, 0); // commit 3 at 60 750
    // Segment-relative: 0.5 s into the segment that started at 20.25 s.
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'uno',
      words: [word('uno', 0.5, 0.75)],
    });
    // Session-relative: already past where its segment started.
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'dos',
      words: [word('dos', 41, 41.5)],
    });
    expect(results().slice(1)).toEqual([
      {
        event: 'final',
        result: {
          text: 'uno',
          words: [{ text: 'uno', startMs: 20_750, endMs: 21_000 }],
          processedMs: 40_500,
        },
      },
      {
        event: 'final',
        result: {
          text: 'dos',
          words: [{ text: 'dos', startMs: 41_000, endMs: 41_500 }],
          processedMs: 60_750,
        },
      },
    ]);
  });

  it('reads an empty commit as a final with no words that still covers its audio', async () => {
    const { session, socket, results } = await started();
    speak(session, 20_000, 0);
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: '',
      words: null,
    });
    expect(results()).toEqual([
      { event: 'final', result: { text: '', words: [], processedMs: 20_000 } },
    ]);
  });

  it.each([
    ['plain first', ['plain', 'timestamped']],
    ['timestamped first', ['timestamped', 'plain']],
  ])('gives one final when both commits arrive (%s)', async (_name, order) => {
    const { session, socket, timer, results } = await started();
    speak(session, 20_000);
    speak(session, 250, 0);
    for (const kind of order) {
      socket().message(
        kind === 'plain'
          ? { message_type: 'committed_transcript', text: 'Hola.' }
          : {
              message_type: 'committed_transcript_with_timestamps',
              text: 'Hola.',
              words: [word('Hola.', 1, 1.5)],
            },
      );
    }
    await timer.advance(ELEVENLABS_PLAIN_HOLD_MS * 4);
    expect(results()).toEqual([
      {
        event: 'final',
        result: {
          text: 'Hola.',
          words: [{ text: 'Hola.', startMs: 1000, endMs: 1500 }],
          processedMs: 20_250,
        },
      },
    ]);
  });

  it('still gives a plain commit whose timestamped one never comes, with spread words', async () => {
    const { session, socket, timer, results } = await started();
    speak(session, 20_000);
    speak(session, 250, 0);
    socket().message({ message_type: 'committed_transcript', text: 'Hola todos' });
    await timer.advance(ELEVENLABS_PLAIN_HOLD_MS - 1);
    expect(results()).toEqual([]);
    await timer.advance(1);
    expect(results()).toEqual([
      {
        event: 'final',
        result: {
          text: 'Hola todos',
          words: [
            { text: 'Hola', startMs: 0, endMs: 10_125 },
            { text: 'todos', startMs: 10_125, endMs: 20_250 },
          ],
          processedMs: 20_250,
        },
      },
    ]);
  });

  it('gives a held plain commit at once when the next plain one arrives', async () => {
    const { session, socket, results } = await started();
    speak(session, 20_000);
    speak(session, 250, 0);
    speak(session, 20_000);
    speak(session, 250, 0);
    socket().message({ message_type: 'committed_transcript', text: 'uno' });
    socket().message({ message_type: 'committed_transcript', text: 'dos' });
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({
      event: 'final',
      result: { text: 'uno', processedMs: 20_250 },
    });
  });

  it('keeps the text of a commit it did not ask for, without claiming more audio', async () => {
    const { session, socket, results } = await started();
    speak(session, 5_000);
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'sorpresa',
      words: [word('sorpresa', 1, 2)],
    });
    expect(results()).toEqual([
      {
        event: 'final',
        result: {
          text: 'sorpresa',
          words: [{ text: 'sorpresa', startMs: 1000, endMs: 2000 }],
          processedMs: 0,
        },
      },
    ]);
  });

  it.each([
    ['text that is not JSON', 'not json {'],
    ['a JSON value that is not an object', '[1,2,3]'],
    ['an object without a type', { text: 'x' }],
    ['an unknown message type', { message_type: 'whatever' }],
    ['a warning', { message_type: 'warning', warning: 'careful' }],
    ['a partial whose text is not a string', { message_type: 'partial_transcript', text: 7 }],
  ])('ignores %s', async (_name, message) => {
    const { socket, heard } = await started();
    expect(() => {
      socket().message(message);
    }).not.toThrow();
    expect(heard).toEqual([{ event: 'opened' }]);
    expect(socket().closes).toEqual([]);
  });

  it('ignores a binary frame', async () => {
    const { socket, heard } = await started();
    socket().binary(new ArrayBuffer(4));
    expect(heard).toEqual([{ event: 'opened' }]);
  });
});

describe('ElevenLabsLiveSpeechProvider: idle', () => {
  it('sends 100 ms of silence after 8 s without audio, and keeps the session clock', async () => {
    const { session, socket, timer, chunks, results } = await started();
    expect(ELEVENLABS_IDLE_SILENCE_MS).toBe(8_000);
    speak(session, 250);
    await timer.advance(ELEVENLABS_IDLE_SILENCE_MS - 1);
    expect(chunks()).toHaveLength(1);
    await timer.advance(1);
    expect(chunks()).toHaveLength(2);
    expect(pcm(chunks()[1] ?? ({} as Chunk))).toEqual(new Array<number>(1600).fill(0));
    await timer.advance(ELEVENLABS_IDLE_SILENCE_MS);
    expect(chunks()).toHaveLength(3);
    speak(session, 1_000);
    socket().message({ message_type: 'partial_transcript', text: 'a b' });
    // The silence was never sent by the engine: its clock is 1 250 ms, not 1 450.
    expect(results().at(-1)).toEqual({
      event: 'interim',
      result: {
        text: 'a b',
        words: [
          { text: 'a', startMs: 0, endMs: 625 },
          { text: 'b', startMs: 625, endMs: 1250 },
        ],
        processedMs: 1250,
      },
    });
  });

  it('sends the audio it holds rather than silence when the engine pauses mid-chunk', async () => {
    const { session, timer, chunks } = await started();
    speak(session, 100);
    await timer.advance(ELEVENLABS_IDLE_SILENCE_MS);
    expect(chunks()).toHaveLength(1);
    expect(pcm(chunks()[0] ?? ({} as Chunk))).toHaveLength(1600);
    expect(pcm(chunks()[0] ?? ({} as Chunk))[0]).toBe(16384);
  });

  it('places words after an idle silence on the engine clock', async () => {
    const { session, socket, timer, results } = await started();
    speak(session, 1_000);
    await timer.advance(ELEVENLABS_IDLE_SILENCE_MS); // 100 ms silence at server 1 000
    speak(session, 19_000);
    speak(session, 250, 0); // commit at engine 20 250, server 20 350
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'x',
      words: [word('x', 2, 2.5)],
    });
    expect(results().at(-1)).toEqual({
      event: 'final',
      result: {
        text: 'x',
        words: [{ text: 'x', startMs: 1900, endMs: 2400 }],
        processedMs: 20_250,
      },
    });
  });
});

describe('ElevenLabsLiveSpeechProvider: finishing', () => {
  it('flushes the held audio with a commit and ends cleanly at its transcript', async () => {
    const { session, socket, chunks, closedWith, heard } = await started();
    speak(session, 1_100);
    session.finish();
    const sent = chunks();
    expect(sent).toHaveLength(5);
    expect(sent.map((chunk) => chunk.commit)).toEqual([false, false, false, false, true]);
    expect(pcm(sent[4] ?? ({} as Chunk))).toHaveLength(1600);
    expect(closedWith()).toBeUndefined();
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'Adiós.',
      words: [word('Adiós.', 0.2, 0.8)],
    });
    expect(closedWith()).toBeNull();
    expect(heard.map((entry) => entry.event)).toEqual(['opened', 'final', 'closed']);
    expect(heard[1]).toMatchObject({ result: { processedMs: 1100 } });
    expect(socket().closes).toHaveLength(1);
    socket().serverClose(1000);
    expect(heard.filter((entry) => entry.event === 'closed')).toHaveLength(1);
  });

  it('commits with an empty chunk when every chunk is sent but not committed', async () => {
    const { session, chunks } = await started();
    speak(session, 500);
    session.finish();
    expect(chunks().at(-1)).toEqual({
      message_type: 'input_audio_chunk',
      audio_base_64: '',
      commit: true,
      sample_rate: 16_000,
    });
  });

  it('waits for every commit still unanswered', async () => {
    const { session, socket, closedWith } = await started();
    speak(session, 20_000);
    speak(session, 250, 0);
    speak(session, 500);
    session.finish();
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'uno',
      words: [],
    });
    expect(closedWith()).toBeUndefined();
    socket().message({
      message_type: 'committed_transcript_with_timestamps',
      text: 'dos',
      words: [],
    });
    expect(closedWith()).toBeNull();
  });

  it('ends at once when there is nothing to commit', async () => {
    const { session, socket, closedWith } = await started();
    session.finish();
    expect(socket().sent).toEqual([]);
    expect(closedWith()).toBeNull();
  });

  it('gives up as TimedOut when the last transcript does not come', async () => {
    const { session, socket, timer, closedWith } = await started();
    speak(session, 1_000);
    session.finish();
    await timer.advance(ELEVENLABS_FINISH_TIMEOUT_MS - 1);
    expect(closedWith()).toBeUndefined();
    await timer.advance(1);
    expect(closedWith()).toMatchObject({ kind: 'TimedOut', displayName: 'ElevenLabs' });
    expect(socket().closes).toHaveLength(1);
  });

  it('ends cleanly through a held plain commit when no timestamped one comes', async () => {
    const { session, socket, timer, closedWith, results } = await started();
    speak(session, 1_000);
    session.finish();
    socket().message({ message_type: 'committed_transcript', text: 'fin' });
    await timer.advance(ELEVENLABS_PLAIN_HOLD_MS);
    expect(results()).toHaveLength(1);
    expect(closedWith()).toBeNull();
  });

  it('sends no audio and no silence after finish, and finishes once', async () => {
    const { session, socket, timer, chunks } = await started();
    speak(session, 1_000);
    session.finish();
    session.finish();
    session.send(tone(500));
    await timer.advance(ELEVENLABS_IDLE_SILENCE_MS * 2);
    expect(chunks()).toHaveLength(5);
    expect(socket().closes).toHaveLength(1);
  });

  it('fails when the connection drops while finishing', async () => {
    const { session, socket, closedWith } = await started();
    speak(session, 1_000);
    session.finish();
    socket().serverClose(1006);
    expect(closedWith()).toMatchObject({ kind: 'Network' });
  });
});

describe('ElevenLabsLiveSpeechProvider: errors', () => {
  it.each([
    ['auth_error', 'KeyInvalid'],
    ['quota_exceeded', 'QuotaExceeded'],
    ['rate_limited', 'RateLimited'],
    ['session_time_limit_exceeded', 'TimedOut'],
    ['transcriber_error', 'TimedOut'],
    ['input_error', 'Unknown'],
    ['error', 'Unknown'],
  ])('ends the session at a %s message as %s', async (messageType, kind) => {
    const { socket, heard, keyChecks } = await started();
    socket().message({ message_type: messageType, error: 'Something happened.' });
    expect(heard).toHaveLength(2);
    expect(heard[1]).toMatchObject({ event: 'closed', error: { kind, displayName: 'ElevenLabs' } });
    expect(socket().closes).toHaveLength(1);
    socket().serverClose(1008);
    expect(heard).toHaveLength(2);
    expect(keyChecks).toEqual([]);
  });

  it('reads an error sent before session_started without a key check', async () => {
    const { socket, closedWith, keyChecks } = await start();
    socket().open();
    socket().message({ message_type: 'auth_error', error: 'Invalid API key' });
    await settle();
    expect(closedWith()).toMatchObject({ kind: 'KeyInvalid' });
    expect(keyChecks).toEqual([]);
  });

  it('never puts the key in the text of a failure', async () => {
    const byMessage = await started();
    byMessage.socket().message({ message_type: 'error', error: `bad key ${KEY} given` });
    const fromMessage = byMessage.closedWith();
    expect(fromMessage?.detail).toContain('[redacted]');
    expect(`${fromMessage?.message ?? ''} ${fromMessage?.detail ?? ''}`).not.toContain(KEY);

    const byClose = await started();
    byClose.socket().serverClose(1008, `policy ${KEY}`);
    const fromClose = byClose.closedWith();
    expect(`${fromClose?.message ?? ''} ${fromClose?.detail ?? ''}`).not.toContain(KEY);
  });

  it.each([
    [1006, 'Network'],
    [1001, 'Network'],
    [1000, 'Network'],
    [1011, 'TimedOut'],
    [1008, 'Unknown'],
  ])('reads close code %i after the start as %s', async (code, kind) => {
    const { socket, heard, keyChecks } = await started();
    socket().serverClose(code);
    await settle();
    expect(heard[1]).toMatchObject({ event: 'closed', error: { kind } });
    expect(keyChecks).toEqual([]);
  });

  it('fails as Network when the socket refuses a frame', async () => {
    const { session, socket, closedWith } = await started();
    socket().sendError = new Error('not open');
    expect(() => {
      speak(session, 300);
    }).not.toThrow();
    expect(closedWith()).toMatchObject({ kind: 'Network' });
  });
});

describe('ElevenLabsLiveSpeechProvider: a session that never starts', () => {
  it('reads a refused connection as KeyInvalid when the key check refuses the key', async () => {
    const { socket, heard, keyChecks, closedWith } = await start({ keyCheck: 'KeyInvalid' });
    socket().fail();
    socket().serverClose(1006);
    await settle();
    expect(keyChecks).toEqual([KEY]);
    expect(closedWith()).toMatchObject({ kind: 'KeyInvalid', displayName: 'ElevenLabs' });
    expect(heard).toHaveLength(1);
  });

  it('reads it as a connection failure when the key is accepted', async () => {
    const { socket, closedWith } = await start({ keyCheck: null });
    socket().serverClose(1006);
    await settle();
    expect(closedWith()).toMatchObject({ kind: 'Network' });
  });

  it('treats a socket that opened but closed before session_started as never started', async () => {
    const { socket, keyChecks, closedWith } = await start({ keyCheck: 'KeyInvalid' });
    socket().open();
    socket().serverClose(1008);
    await settle();
    expect(keyChecks).toEqual([KEY]);
    expect(closedWith()).toMatchObject({ kind: 'KeyInvalid' });
  });

  it('does not check a key an earlier session started with', async () => {
    const { provider, sockets, socket, keyChecks } = await started({ keyCheck: 'KeyInvalid' });
    socket().serverClose(1006);
    const reopened: (ApiProviderError | null)[] = [];
    provider.open(
      { language: 'es', sampleRate: RATE, cancel: new CancelSource().signal },
      {
        opened: () => undefined,
        interim: () => undefined,
        final: () => undefined,
        closed: (error) => reopened.push(error),
      },
    );
    await settle();
    sockets.sockets[1]?.fail();
    sockets.sockets[1]?.serverClose(1006);
    await settle();
    expect(reopened).toEqual([expect.objectContaining({ kind: 'Network' })]);
    expect(keyChecks).toEqual([]);
  });

  it('checks the key once when both the error and the close arrive', async () => {
    const { socket, keyChecks, heard } = await start({ keyCheck: 'KeyInvalid' });
    socket().fail();
    socket().serverClose(1006);
    socket().serverClose(1006);
    await settle();
    expect(keyChecks).toHaveLength(1);
    expect(heard).toHaveLength(1);
  });

  it('explains a socket that could not be created the same way', async () => {
    const sockets = new ScriptedLiveSockets();
    sockets.createError = new Error(`cannot connect with ${KEY}`);
    const heard: (ApiProviderError | null)[] = [];
    new ElevenLabsLiveSpeechProvider({
      displayName: 'ElevenLabs',
      baseUrl: ELEVENLABS_BASE_URL,
      model: 'scribe_v2_realtime',
      apiKey: () => Promise.resolve(KEY),
      timer: new ManualSpeechTimer(),
      socket: sockets.factory,
      checkKey: () => Promise.resolve(),
    }).open(
      { language: 'es', sampleRate: RATE, cancel: new CancelSource().signal },
      {
        opened: () => undefined,
        interim: () => undefined,
        final: () => undefined,
        closed: (error) => heard.push(error),
      },
    );
    await settle();
    expect(heard).toEqual([expect.objectContaining({ kind: 'Network' })]);
    expect(heard[0]?.message).not.toContain(KEY);
  });
});

describe('ElevenLabsLiveSpeechProvider: close and cancel', () => {
  it('closes the socket, stops the timers and tells the listener nothing more', async () => {
    const { session, socket, timer, heard } = await started();
    speak(session, 100);
    session.close();
    expect(socket().closes).toHaveLength(1);
    await timer.advance(ELEVENLABS_IDLE_SILENCE_MS * 3);
    socket().message({ message_type: 'partial_transcript', text: 'tarde' });
    socket().serverClose(1006);
    session.send(tone(500));
    session.finish();
    await settle();
    expect(heard).toEqual([{ event: 'opened' }]);
    expect(socket().sent).toEqual([]);
  });

  it('does not wait for the last transcript when closed while finishing', async () => {
    const { session, timer, heard } = await started();
    speak(session, 1_000);
    session.finish();
    session.close();
    await timer.advance(ELEVENLABS_FINISH_TIMEOUT_MS * 2);
    expect(heard).toEqual([{ event: 'opened' }]);
  });

  it('ends at once when the pass is cancelled', async () => {
    const cancel = new CancelSource();
    const { socket, heard } = await started({ cancel: cancel.signal });
    cancel.cancel();
    expect(socket().closes).toHaveLength(1);
    socket().serverClose(1006);
    await settle();
    expect(heard).toEqual([{ event: 'opened' }]);
  });

  it('closes a socket that starts after the session was closed', async () => {
    const { session, socket, heard } = await start();
    session.close();
    socket().open();
    socket().message({ message_type: 'session_started', session_id: 's', config: {} });
    expect(heard).toEqual([]);
    expect(socket().closes.length).toBeGreaterThan(0);
  });
});
