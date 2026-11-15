import {
  CancelSource,
  isFatalSpeechFailure,
  ManualSpeechTimer,
  StreamingSpeechEngine,
  StreamingTranscriptAccumulator,
  type ApiProviderError,
  type AsrStream,
  type StreamingSpeechResult,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import {
  FAKE_STREAM_WORD_MS,
  FakeStreamingSpeechProvider,
  fakeStreamingSpeechOptionsFromEnv,
  type FakeStreamingSpeechOptions,
} from './fake-streaming-speech-provider';

const RATE = 1000;
const audio = (durationMs: number): Float32Array =>
  new Float32Array((durationMs * RATE) / 1000).fill(0.5);

const PHRASES = ['Hola a todos.', 'Hoy revisamos el plan.'];

/** The fake behind the real streaming engine, as the app will wire it. */
async function live(options: FakeStreamingSpeechOptions = {}) {
  const timer = new ManualSpeechTimer();
  const provider = new FakeStreamingSpeechProvider({ phrases: PHRASES, ...options }, timer);
  const lost: { error: unknown; lostMs: number }[] = [];
  const engine = new StreamingSpeechEngine({
    provider,
    timer,
    onLost: (error, lostMs) => lost.push({ error, lostMs }),
  });
  const recognizer = await engine.createRecognizer({ latency: 'live' });
  const stream = await recognizer.startStream({
    language: 'es-US',
    interimResults: true,
    diarization: false,
  });
  const accumulator = new StreamingTranscriptAccumulator(null);
  const push = async (durationMs: number): Promise<void> => {
    await stream.push(audio(durationMs), RATE);
    for (const result of await stream.pullAvailable()) accumulator.apply(result);
  };
  const pull = async (): Promise<void> => {
    for (const result of await stream.pullAvailable()) accumulator.apply(result);
  };
  return { timer, provider, lost, stream, accumulator, push, pull };
}

const drain = (stream: AsrStream) => {
  if (!stream.drain) throw new Error('the streaming stream must drain');
  return stream.drain();
};

describe('FakeStreamingSpeechProvider behind the streaming engine', () => {
  it('rewrites the line word by word, then commits it when the phrase ends', async () => {
    const { accumulator, push } = await live();
    await push(FAKE_STREAM_WORD_MS);
    expect(accumulator.displayText).toBe('[00:00.00-00:00.40] Hola');
    expect(accumulator.committedText).toBe('');

    await push(FAKE_STREAM_WORD_MS);
    expect(accumulator.displayText).toBe('[00:00.00-00:00.90] Hola a');
    expect(accumulator.committedText).toBe('');

    await push(FAKE_STREAM_WORD_MS);
    expect(accumulator.committedText).toBe('[00:00.00-00:01.40] Hola a todos.');
    expect(accumulator.displayText).toBe(accumulator.committedText);

    await push(FAKE_STREAM_WORD_MS);
    expect(accumulator.displayText).toBe(
      '[00:00.00-00:01.40] Hola a todos.\n[00:01.50-00:01.90] Hoy',
    );
  });

  it('hears one word per half second however the audio is cut, and repeats its script', async () => {
    const { accumulator, push } = await live();
    await push(200);
    expect(accumulator.displayText).toBe('');
    // 3.5 s more: the three words of the first phrase and the four of the second.
    await push(3500);
    expect(accumulator.committedText).toBe(
      '[00:00.00-00:01.40] Hola a todos.\n[00:01.50-00:03.40] Hoy revisamos el plan.',
    );
    await push(1300);
    expect(accumulator.displayText.split('\n')[2]).toBe('[00:03.50-00:04.90] Hola a todos.');
  });

  it('ends the unfinished phrase as a final at Stop and loses nothing', async () => {
    const { stream, accumulator, push, pull } = await live();
    await push(2 * FAKE_STREAM_WORD_MS);
    expect(accumulator.committedText).toBe('');
    expect(await drain(stream)).toEqual({ lostMs: 0 });
    await pull();
    expect(accumulator.committedText).toBe('[00:00.00-00:00.90] Hola a');
  });

  it('opens and answers only after its delay', async () => {
    const { timer, provider, accumulator, push, pull } = await live({ delayMs: 300 });
    await push(FAKE_STREAM_WORD_MS);
    expect(provider.sessions[0]?.receivedMs).toBe(0);
    await timer.advance(299);
    expect(provider.sessions[0]?.receivedMs).toBe(0);
    // Opened: the engine sends what was waiting, and the answer takes the delay again.
    await timer.advance(1);
    expect(provider.sessions[0]?.receivedMs).toBe(FAKE_STREAM_WORD_MS);
    await pull();
    expect(accumulator.displayText).toBe('');
    await timer.advance(300);
    await pull();
    expect(accumulator.displayText).toBe('[00:00.00-00:00.40] Hola');
  });

  it('answers a delayed Stop in order: the last final, then the clean end', async () => {
    const { timer, stream, accumulator, push, pull } = await live({ delayMs: 100 });
    await push(FAKE_STREAM_WORD_MS);
    await timer.advance(100);
    const closing = drain(stream);
    await timer.advance(200);
    expect(await closing).toEqual({ lostMs: 0 });
    await pull();
    expect(accumulator.committedText).toBe('[00:00.00-00:00.40] Hola');
  });

  it.each(['KeyInvalid', 'QuotaExceeded'] as const)(
    'refuses the session with %s, which ends the live text',
    async (kind) => {
      const { lost, stream, push, accumulator } = await live({ failWith: kind });
      await push(FAKE_STREAM_WORD_MS);
      await push(FAKE_STREAM_WORD_MS);
      expect(lost).toHaveLength(1);
      expect((lost[0]?.error as ApiProviderError).kind).toBe(kind);
      expect(isFatalSpeechFailure(lost[0]?.error)).toBe(true);
      expect(accumulator.displayText).toBe('');
      expect(await drain(stream)).toEqual({ lostMs: 2 * FAKE_STREAM_WORD_MS });
    },
  );

  it('fails as Unknown for any other failure text', async () => {
    const { lost, push } = await live({ failWith: 'boom' });
    await push(FAKE_STREAM_WORD_MS);
    expect(lost[0]?.error).toMatchObject({ kind: 'Unknown', detail: 'boom' });
  });
});

describe('FakeStreamingSpeechProvider sessions', () => {
  const listen = () => {
    const heard: string[] = [];
    const results: StreamingSpeechResult[] = [];
    return {
      heard,
      results,
      listener: {
        opened: () => heard.push('opened'),
        interim: (result: StreamingSpeechResult) => {
          heard.push('interim');
          results.push(result);
        },
        final: (result: StreamingSpeechResult) => {
          heard.push('final');
          results.push(result);
        },
        closed: (error: ApiProviderError | null) =>
          heard.push(error === null ? 'closed' : error.kind),
      },
    };
  };
  const options = (cancel = new CancelSource()) => ({
    language: 'es',
    sampleRate: RATE,
    cancel: cancel.signal,
  });

  it('gives each result the provider-style punctuated words and how far it listened', async () => {
    const { heard, results, listener } = listen();
    const provider = new FakeStreamingSpeechProvider({ phrases: PHRASES });
    const session = provider.open(options(), listener);
    session.send(audio(3 * FAKE_STREAM_WORD_MS));
    expect(heard).toEqual(['opened', 'interim', 'interim', 'final']);
    expect(results[2]).toEqual({
      text: 'Hola a todos.',
      words: [
        { text: 'Hola', startMs: 0, endMs: 400 },
        { text: 'a', startMs: 500, endMs: 900 },
        { text: 'todos.', startMs: 1000, endMs: 1400 },
      ],
      processedMs: 1500,
    });
    expect(provider.displayName).toBe('Fake streaming speech');
  });

  it('says nothing more once it is closed or its pass is cancelled', async () => {
    const closed = listen();
    const first = new FakeStreamingSpeechProvider({ phrases: PHRASES }).open(
      options(),
      closed.listener,
    );
    first.close();
    first.send(audio(2000));
    first.finish();
    expect(closed.heard).toEqual(['opened']);

    const cancel = new CancelSource();
    const cancelled = listen();
    const second = new FakeStreamingSpeechProvider({ phrases: PHRASES }).open(
      options(cancel),
      cancelled.listener,
    );
    cancel.cancel();
    second.send(audio(2000));
    expect(cancelled.heard).toEqual(['opened']);
  });

  it('ends cleanly with nothing to say when it was sent no audio', async () => {
    const { heard, listener } = listen();
    const session = new FakeStreamingSpeechProvider({ phrases: PHRASES }).open(options(), listener);
    session.finish();
    session.finish();
    expect(heard).toEqual(['opened', 'closed']);
  });

  it('reads the default script of the fake speech engine', async () => {
    const { results, listener } = listen();
    new FakeStreamingSpeechProvider().open(options(), listener).send(audio(FAKE_STREAM_WORD_MS));
    expect(results[0]?.text).toBe('Buenos');
  });
});

describe('fakeStreamingSpeechOptionsFromEnv', () => {
  it('reads the delay and the failure', () => {
    expect(
      fakeStreamingSpeechOptionsFromEnv({
        VOZELLA_FAKE_STREAM_DELAY_MS: '250',
        VOZELLA_FAKE_STREAM_FAIL: ' KeyInvalid ',
      }),
    ).toEqual({ delayMs: 250, failWith: 'KeyInvalid' });
  });

  it.each([undefined, '', 'abc', '-5'])('reads no delay from %j and no failure', (delay) => {
    expect(
      fakeStreamingSpeechOptionsFromEnv({
        VOZELLA_FAKE_STREAM_DELAY_MS: delay,
        VOZELLA_FAKE_STREAM_FAIL: '  ',
      }),
    ).toEqual({ delayMs: 0, failWith: null });
  });
});
