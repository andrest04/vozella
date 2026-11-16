import { describe, expect, it } from 'vitest';
import { CancelSource, type CancelSignal } from '../cancel';
import { ApiProviderError, type ApiFailureKind } from '../summaries/api-failure';
import { StreamingTranscriptAccumulator } from './accumulator';
import type { AsrStream } from './asr-types';
import { TranscriptionCancelledError } from './ports';
import type { StreamingSpeechResult } from './streaming-speech';
import {
  STREAMING_MAX_BUFFERED_MS,
  STREAMING_OPEN_TIMEOUT_MS,
  STREAMING_REOPEN_DELAYS_MS,
  STREAMING_UNCONFIRMED_TOLERANCE_MS,
  StreamingSpeechEngine,
} from './streaming-speech-engine';
import { ManualSpeechTimer, ScriptedStreamingSpeechProvider } from './test-kit';

/** A low rate keeps the arrays small; the engine works in milliseconds of whatever rate it gets. */
const RATE = 1000;
const audio = (durationMs: number): Float32Array =>
  new Float32Array((durationMs * RATE) / 1000).fill(0.5);

const failure = (kind: ApiFailureKind): ApiProviderError => new ApiProviderError('Scripted', kind);

/** A result whose words are `text` spread evenly from `startMs` to `endMs`. */
function said(text: string, startMs: number, endMs: number): StreamingSpeechResult {
  const tokens = text.split(' ');
  const step = (endMs - startMs) / tokens.length;
  return {
    text,
    words: tokens.map((token, index) => ({
      text: token,
      startMs: Math.round(startMs + index * step),
      endMs: Math.round(startMs + (index + 1) * step),
    })),
    processedMs: endMs,
  };
}

const silence = (processedMs: number): StreamingSpeechResult => ({
  text: '',
  words: [],
  processedMs,
});

async function open(options: { cancel?: CancelSignal; language?: string } = {}) {
  const provider = new ScriptedStreamingSpeechProvider();
  const timer = new ManualSpeechTimer();
  const lost: { error: unknown; lostMs: number }[] = [];
  const engine = new StreamingSpeechEngine({
    provider,
    timer,
    onLost: (error, lostMs) => lost.push({ error, lostMs }),
  });
  const recognizer = await engine.createRecognizer({ latency: 'live' }, options.cancel);
  const stream = await recognizer.startStream({
    language: options.language ?? 'es-US',
    interimResults: true,
    diarization: false,
  });
  const session = () => {
    const first = provider.sessions[0];
    if (first === undefined) throw new Error('no session was opened');
    return first;
  };
  /** The nth session the engine opened, counting from zero. */
  const sessionAt = (index: number) => {
    const found = provider.sessions[index];
    if (found === undefined) throw new Error(`session ${index} was not opened`);
    return found;
  };
  return { provider, timer, lost, recognizer, stream, session, sessionAt };
}

const FIRST_REOPEN_MS = STREAMING_REOPEN_DELAYS_MS[0] ?? 0;
const LAST_REOPEN_MS = STREAMING_REOPEN_DELAYS_MS.at(-1) ?? 0;

const drain = (stream: AsrStream) => {
  if (!stream.drain) throw new Error('the streaming stream must drain');
  return stream.drain();
};

/** Lets every promise that can settle without more input settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

describe('StreamingSpeechEngine connection', () => {
  it('opens no session until the first audio arrives, then one with its language and rate', async () => {
    const { provider, stream, session } = await open({ language: 'en-US' });
    expect(provider.sessions).toHaveLength(0);
    await stream.push(audio(100), RATE);
    await stream.push(audio(100), RATE);
    expect(provider.sessions).toHaveLength(1);
    expect(session().options.language).toBe('en-US');
    expect(session().options.sampleRate).toBe(RATE);
  });

  it('keeps the audio pushed before the session opens and sends it in order on open', async () => {
    const { stream, session } = await open();
    const first = audio(100).fill(0.1);
    const second = audio(200).fill(0.2);
    await stream.push(first, RATE);
    await stream.push(second, RATE);
    expect(session().sent).toEqual([]);
    session().listener.opened();
    expect(session().sent).toEqual([first, second]);
    const third = audio(50);
    await stream.push(third, RATE);
    expect(session().sent).toEqual([first, second, third]);
  });

  it('ignores empty frames and frames without a rate', async () => {
    const { provider, stream } = await open();
    await stream.push(new Float32Array(0), RATE);
    await stream.push(audio(100), 0);
    expect(provider.sessions).toHaveLength(0);
  });

  it('drops the oldest waiting audio past the limit, counts it and shifts the times by it', async () => {
    const { stream, session, lost } = await open();
    await stream.push(audio(STREAMING_MAX_BUFFERED_MS), RATE);
    await stream.push(audio(2000), RATE);
    session().listener.opened();
    expect(lost).toEqual([{ error: null, lostMs: 2000 }]);
    expect(session().sentSamples).toBe((STREAMING_MAX_BUFFERED_MS * RATE) / 1000);
    // The provider counts from the first sample it was sent, which is 2 s into the stream.
    session().listener.final(said('hola', 100, 400));
    const [result] = await stream.pullAvailable();
    expect(result?.words[0]).toMatchObject({ startMs: 2100, endMs: 2400 });
    expect(result?.audioProcessedSeconds).toBe(2.4);
    const closing = drain(stream);
    session().listener.final(silence(STREAMING_MAX_BUFFERED_MS));
    session().listener.closed(null);
    expect(await closing).toEqual({ lostMs: 2000 });
  });

  it('gives up on a session that does not open in time and opens another with the waiting audio', async () => {
    const { provider, stream, session, sessionAt, lost, timer } = await open();
    await stream.push(audio(300), RATE);
    await timer.advance(STREAMING_OPEN_TIMEOUT_MS - 1);
    expect(lost).toEqual([]);
    await timer.advance(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.lostMs).toBe(0);
    expect(lost[0]?.error).toMatchObject({ kind: 'TimedOut', displayName: 'Scripted' });
    expect(session().closed).toBe(true);
    expect(provider.sessions).toHaveLength(1);

    await timer.advance(FIRST_REOPEN_MS);
    expect(provider.sessions).toHaveLength(2);
    sessionAt(1).listener.opened();
    expect(sessionAt(1).sentSamples).toBe(300);
    const closing = drain(stream);
    sessionAt(1).listener.final(silence(300));
    sessionAt(1).listener.closed(null);
    expect(await closing).toEqual({ lostMs: 0 });
  });

  it('gives up for good on a session that does not open in time once Stop is waiting', async () => {
    const { provider, stream, lost, timer } = await open();
    await stream.push(audio(300), RATE);
    const closing = drain(stream);
    await timer.advance(STREAMING_OPEN_TIMEOUT_MS);
    expect(await closing).toEqual({ lostMs: 300 });
    expect(lost).toHaveLength(1);
    expect(lost[0]?.lostMs).toBe(300);
    await timer.advance(LAST_REOPEN_MS * 3);
    expect(provider.sessions).toHaveLength(1);
  });

  it('does not time out a session that opened', async () => {
    const { stream, session, lost, timer } = await open();
    await stream.push(audio(300), RATE);
    session().listener.opened();
    await timer.advance(STREAMING_OPEN_TIMEOUT_MS * 2);
    expect(lost).toEqual([]);
    expect(session().closed).toBe(false);
  });

  it('survives a provider that throws from open: the audio is lost, push does not throw', async () => {
    const { provider, stream, lost } = await open();
    provider.openError = new Error('boom');
    await expect(stream.push(audio(100), RATE)).resolves.toBeUndefined();
    await stream.push(audio(100), RATE);
    // Reported as a failed open; the audio waits for the next try and is lost only at Stop.
    expect(lost).toEqual([{ error: provider.openError, lostMs: 0 }]);
    expect(await drain(stream)).toEqual({ lostMs: 200 });
    expect(lost[1]).toEqual({ error: provider.openError, lostMs: 200 });
  });

  it('refuses the offline profile: a streaming engine serves the live pass only', async () => {
    const engine = new StreamingSpeechEngine({
      provider: new ScriptedStreamingSpeechProvider(),
      timer: new ManualSpeechTimer(),
    });
    await expect(engine.createRecognizer({ latency: 'offline' })).rejects.toThrow(/live/);
  });
});

describe('StreamingSpeechEngine results', () => {
  it('rewrites the interim text and commits the final through the accumulator', async () => {
    const { stream, session } = await open();
    const accumulator = new StreamingTranscriptAccumulator(null);
    const apply = async (): Promise<void> => {
      for (const result of await stream.pullAvailable()) accumulator.apply(result);
    };
    await stream.push(audio(1000), RATE);
    session().listener.opened();

    session().listener.interim(said('Hola', 0, 400));
    await apply();
    expect(accumulator.displayText).toBe('[00:00.00-00:00.40] Hola');
    expect(accumulator.committedText).toBe('');

    session().listener.interim(said('Hola a', 0, 600));
    await apply();
    expect(accumulator.displayText).toBe('[00:00.00-00:00.60] Hola a');

    session().listener.final(said('Hola a todos.', 0, 900));
    await apply();
    expect(accumulator.committedText).toBe('[00:00.00-00:00.90] Hola a todos.');
    expect(accumulator.displayText).toBe(accumulator.committedText);

    session().listener.interim(said('Hoy', 1000, 1300));
    await apply();
    expect(accumulator.displayText).toBe(
      '[00:00.00-00:00.90] Hola a todos.\n[00:01.00-00:01.30] Hoy',
    );
    expect(accumulator.committedText).toBe('[00:00.00-00:00.90] Hola a todos.');
  });

  it('maps a final to untagged words with the punctuated text and absolute times', async () => {
    const { stream, session } = await open();
    await stream.push(audio(3000), RATE);
    session().listener.opened();
    session().listener.final(said('Hola a todos.', 100, 1000));
    session().listener.final(said('Hoy revisamos.', 1200, 2800));
    const results = await stream.pullAvailable();
    expect(results.map((result) => result.isFinal)).toEqual([true, true]);
    expect(results[0]).toEqual({
      isFinal: true,
      transcript: 'Hola a todos.',
      audioProcessedSeconds: 1,
      words: [
        { startMs: 100, endMs: 400, speakerTag: 0, text: 'Hola' },
        { startMs: 400, endMs: 700, speakerTag: 0, text: 'a' },
        { startMs: 700, endMs: 1000, speakerTag: 0, text: 'todos.' },
      ],
    });
    // Times count from the start of the stream in every segment, so they never go back.
    const starts = results.flatMap((result) => result.words.map((word) => word.startMs));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(results[1]?.words[0]?.startMs).toBe(1200);
    expect(results[1]?.audioProcessedSeconds).toBe(2.8);
  });

  it('builds the transcript from the words when the provider gives no text', async () => {
    const { stream, session } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final({ ...said('Hola a todos.', 0, 900), text: '  ' });
    expect((await stream.pullAvailable())[0]?.transcript).toBe('Hola a todos.');
  });

  it('emits nothing for silence while no interim text is on screen', async () => {
    const { stream, session } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.interim(silence(300));
    session().listener.final(silence(600));
    expect(await stream.pullAvailable()).toEqual([]);
  });

  it('withdraws the interim text when its segment ends as an empty final, committing nothing', async () => {
    const { stream, session } = await open();
    const accumulator = new StreamingTranscriptAccumulator(null);
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.interim(said('uh', 0, 300));
    session().listener.final(silence(600));
    // The same silence again has nothing left to withdraw.
    session().listener.final(silence(900));

    const results = await stream.pullAvailable();
    expect(results).toEqual([
      expect.objectContaining({ isFinal: false, transcript: 'uh' }),
      { isFinal: true, transcript: '', audioProcessedSeconds: 0.6, words: [] },
    ]);
    for (const result of results) accumulator.apply(result);
    expect(accumulator.displayText).toBe('');
    // What Stop does with a leftover interim: there is none to save.
    accumulator.commitRemainingInterim();
    expect(accumulator.committedText).toBe('');
  });

  it('withdraws the interim text when the provider takes it back in a later interim', async () => {
    const { stream, session } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.interim(said('uh', 0, 300));
    session().listener.interim(silence(500));
    expect((await stream.pullAvailable())[1]).toEqual({
      isFinal: false,
      transcript: '',
      audioProcessedSeconds: 0.5,
      words: [],
    });
  });

  it('hands each result over once', async () => {
    const { stream, session } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final(said('hola', 0, 400));
    expect(await stream.pullAvailable()).toHaveLength(1);
    expect(await stream.pullAvailable()).toEqual([]);
  });
});

describe('StreamingSpeechEngine drain', () => {
  it('finishes the session, waits for the last finals and reports nothing lost', async () => {
    const { stream, session } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final(said('hola', 0, 400));

    let done = false;
    const closing = drain(stream).then((coverage) => {
      done = true;
      return coverage;
    });
    await settle();
    expect(session().finished).toBe(true);
    expect(done).toBe(false);

    session().listener.final(said('adiós', 500, 900));
    session().listener.closed(null);
    expect(await closing).toEqual({ lostMs: 0 });
    expect((await stream.pullAvailable()).map((result) => result.transcript)).toEqual([
      'hola',
      'adiós',
    ]);
    // The session ended by itself: closing the stream has nothing left to abandon.
    await stream.dispose();
    expect(session().closed).toBe(false);
  });

  it('reports exactly zero lost for a stream that was never given audio', async () => {
    const { provider, stream } = await open();
    expect(await drain(stream)).toEqual({ lostMs: 0 });
    expect(provider.sessions).toHaveLength(0);
  });

  it('drains a session that has not opened yet: it flushes, then finishes', async () => {
    const { stream, session } = await open();
    await stream.push(audio(400), RATE);
    const closing = drain(stream);
    await settle();
    expect(session().finished).toBe(false);
    session().listener.opened();
    expect(session().sentSamples).toBe(400);
    expect(session().finished).toBe(true);
    session().listener.final(silence(400));
    session().listener.closed(null);
    expect(await closing).toEqual({ lostMs: 0 });
  });

  it('counts the audio the provider never confirmed when the session drops mid-stream', async () => {
    const { stream, session, lost } = await open();
    await stream.push(audio(3000), RATE);
    session().listener.opened();
    session().listener.final(said('hola', 0, 1000));
    // An interim is not a confirmation: its text may never become final.
    session().listener.interim(said('y', 1000, 1800));
    session().listener.closed(failure('Network'));
    expect(lost).toEqual([{ error: failure('Network'), lostMs: 2000 }]);

    // Stop comes before the session is open again: what waited for it is lost too.
    await stream.push(audio(500), RATE);
    expect(lost).toHaveLength(1);
    expect(session().sentSamples).toBe(3000);
    expect(await drain(stream)).toEqual({ lostMs: 2500 });
    expect(lost[1]).toEqual({ error: failure('Network'), lostMs: 500 });
  });

  it('counts silence the provider listened to as confirmed', async () => {
    const { stream, session } = await open();
    await stream.push(audio(3000), RATE);
    session().listener.opened();
    session().listener.final(silence(2500));
    session().listener.closed(failure('Network'));
    expect(await drain(stream)).toEqual({ lostMs: 500 });
  });

  it('treats a session that ends without being asked to as a dropped connection', async () => {
    const { stream, session, lost } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.closed(null);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.error).toMatchObject({ kind: 'Network' });
    expect(await drain(stream)).toEqual({ lostMs: 1000 });
  });

  it('ends a pending drain when the session fails while finishing, without opening another', async () => {
    const { provider, stream, session, timer } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final(said('hola', 0, 600));
    const closing = drain(stream);
    session().listener.closed(failure('Network'));
    expect(await closing).toEqual({ lostMs: 400 });
    await timer.advance(LAST_REOPEN_MS * 3);
    expect(provider.sessions).toHaveLength(1);
  });

  it('ends a pending drain at once when the stream is disposed, losing the unfinished audio', async () => {
    const { stream, session, lost } = await open();
    await stream.push(audio(2000), RATE);
    session().listener.opened();
    session().listener.final(said('hola', 0, 500));
    const closing = drain(stream);
    await settle();
    await stream.dispose();
    expect(await closing).toEqual({ lostMs: 1500 });
    expect(session().closed).toBe(true);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.error).toBeInstanceOf(TranscriptionCancelledError);
    expect(lost[0]?.lostMs).toBe(1500);
    // What was final before the stream closed can still be pulled; late events change nothing.
    expect((await stream.pullAvailable()).map((result) => result.transcript)).toEqual(['hola']);
    session().listener.final(said('tarde', 600, 900));
    session().listener.closed(null);
    expect(await stream.pullAvailable()).toEqual([]);
    expect(lost).toHaveLength(1);
  });

  it('counts the audio a session never answered for when it ends cleanly short of what it was sent', async () => {
    const { stream, session, lost } = await open();
    await stream.push(audio(3000), RATE);
    session().listener.opened();
    session().listener.final(said('hola', 0, 1000));
    const closing = drain(stream);
    session().listener.closed(null);
    expect(await closing).toEqual({ lostMs: 2000 });
    expect(lost).toHaveLength(1);
    expect(lost[0]?.lostMs).toBe(2000);
    expect(lost[0]?.error).toMatchObject({ kind: 'Unknown', displayName: 'Scripted' });
  });

  it.each([
    [STREAMING_UNCONFIRMED_TOLERANCE_MS, 0],
    [STREAMING_UNCONFIRMED_TOLERANCE_MS + 1, STREAMING_UNCONFIRMED_TOLERANCE_MS + 1],
  ])('a clean end %i ms short of the audio sent loses %i ms', async (shortfallMs, lostMs) => {
    const { stream, session, lost } = await open();
    await stream.push(audio(2000), RATE);
    session().listener.opened();
    session().listener.final(silence(2000 - shortfallMs));
    const closing = drain(stream);
    session().listener.closed(null);
    expect(await closing).toEqual({ lostMs });
    expect(lost).toHaveLength(lostMs === 0 ? 0 : 1);
  });

  it('counts audio pushed after the drain began as lost', async () => {
    const { stream, session } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    const closing = drain(stream);
    await stream.push(audio(300), RATE);
    expect(session().sentSamples).toBe(1000);
    session().listener.final(silence(1000));
    session().listener.closed(null);
    expect(await closing).toEqual({ lostMs: 300 });
  });
});

describe('StreamingSpeechEngine reopening a dropped session', () => {
  it.each(['Network', 'TimedOut', 'Unknown', 'RateLimited'] as const)(
    'opens a new session after a %s drop and keeps the times on the clock of the stream',
    async (kind) => {
      const { provider, stream, session, sessionAt, lost, timer } = await open({
        language: 'en-US',
      });
      await stream.push(audio(3000), RATE);
      session().listener.opened();
      session().listener.final(said('hola', 0, 1000));
      session().listener.closed(failure(kind));
      // Sent and never confirmed by a final: lost, so the pass after Stop still runs.
      expect(lost).toEqual([{ error: failure(kind), lostMs: 2000 }]);

      // Audio pushed while the session is down waits for the next one.
      const waited = audio(500).fill(0.25);
      await stream.push(waited, RATE);
      await timer.advance(FIRST_REOPEN_MS - 1);
      expect(provider.sessions).toHaveLength(1);
      await timer.advance(1);
      expect(provider.sessions).toHaveLength(2);
      expect(sessionAt(1).options).toMatchObject({ language: 'en-US', sampleRate: RATE });
      expect(sessionAt(1).sent).toEqual([]);
      sessionAt(1).listener.opened();
      expect(sessionAt(1).sent).toEqual([waited]);

      // The new session counts from zero; the stream had already heard three seconds.
      sessionAt(1).listener.final(said('mundo', 100, 400));
      const results = await stream.pullAvailable();
      expect(results.map((result) => result.transcript)).toEqual(['hola', 'mundo']);
      expect(results[1]?.words).toEqual([
        { startMs: 3100, endMs: 3400, speakerTag: 0, text: 'mundo' },
      ]);
      expect(results[1]?.audioProcessedSeconds).toBe(3.4);

      const closing = drain(stream);
      sessionAt(1).listener.final(silence(500));
      sessionAt(1).listener.closed(null);
      expect(await closing).toEqual({ lostMs: 2000 });
      expect(lost).toHaveLength(1);
    },
  );

  it('waits longer before each try that fails, and starts over once a session answers', async () => {
    const { provider, stream, sessionAt, timer } = await open();
    await stream.push(audio(100), RATE);
    const reopenWaits = () => timer.waits.filter((wait) => wait !== STREAMING_OPEN_TIMEOUT_MS);
    for (let index = 0; index <= STREAMING_REOPEN_DELAYS_MS.length; index += 1) {
      sessionAt(index).listener.closed(failure('Network'));
      await timer.advance(LAST_REOPEN_MS);
    }
    expect(reopenWaits()).toEqual([...STREAMING_REOPEN_DELAYS_MS, LAST_REOPEN_MS]);
    expect(STREAMING_REOPEN_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000]);

    // A session that opens and drops without one final is still a failed try.
    const failed = provider.sessions.length - 1;
    sessionAt(failed).listener.opened();
    sessionAt(failed).listener.closed(failure('Network'));
    await timer.advance(LAST_REOPEN_MS);
    expect(reopenWaits().at(-1)).toBe(LAST_REOPEN_MS);

    // One that gave a final worked: the next drop is retried quickly again.
    const working = provider.sessions.length - 1;
    sessionAt(working).listener.opened();
    sessionAt(working).listener.final(silence(100));
    sessionAt(working).listener.closed(failure('Network'));
    expect(reopenWaits().at(-1)).toBe(FIRST_REOPEN_MS);
  });

  it('reports a long outage once, then only when it loses audio', async () => {
    const { stream, sessionAt, lost, timer } = await open();
    await stream.push(audio(100), RATE);
    for (let index = 0; index < 3; index += 1) {
      sessionAt(index).listener.closed(failure('Network'));
      await timer.advance(LAST_REOPEN_MS);
    }
    expect(lost).toEqual([{ error: failure('Network'), lostMs: 0 }]);
  });

  it('keeps at most the buffer limit while it is down and shifts the times by what it dropped', async () => {
    const { stream, session, sessionAt, lost, timer } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final(silence(1000));
    session().listener.closed(failure('Network'));
    expect(lost).toEqual([{ error: failure('Network'), lostMs: 0 }]);

    await stream.push(audio(STREAMING_MAX_BUFFERED_MS), RATE);
    await stream.push(audio(1500), RATE);
    await stream.push(audio(500), RATE);
    // Not one report per frame: the overflow is told when the next session opens.
    expect(lost).toHaveLength(1);
    await timer.advance(FIRST_REOPEN_MS);
    sessionAt(1).listener.opened();
    expect(lost[1]).toEqual({ error: null, lostMs: 2000 });
    expect(sessionAt(1).sentSamples).toBe((STREAMING_MAX_BUFFERED_MS * RATE) / 1000);

    // Its first sample is 1 s sent to the first session plus the 2 s dropped into the stream.
    sessionAt(1).listener.final(said('hola', 0, 400));
    expect((await stream.pullAvailable())[0]?.words[0]).toMatchObject({
      startMs: 3000,
      endMs: 3400,
    });
    const closing = drain(stream);
    sessionAt(1).listener.final(silence(STREAMING_MAX_BUFFERED_MS));
    sessionAt(1).listener.closed(null);
    expect(await closing).toEqual({ lostMs: 2000 });
  });

  it.each(['KeyMissing', 'KeyInvalid', 'QuotaExceeded', 'ModelNotFound'] as const)(
    'does not reopen after %s: the stream ends and later audio is lost',
    async (kind) => {
      const { provider, stream, session, lost, timer } = await open();
      await stream.push(audio(1000), RATE);
      session().listener.opened();
      session().listener.final(silence(400));
      session().listener.closed(failure(kind));
      expect(lost).toEqual([{ error: failure(kind), lostMs: 600 }]);
      await stream.push(audio(300), RATE);
      await timer.advance(LAST_REOPEN_MS * 3);
      expect(provider.sessions).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(await drain(stream)).toEqual({ lostMs: 900 });
    },
  );

  it('ends for good when a reopened session is refused for a reason waiting cannot fix', async () => {
    const { provider, stream, session, sessionAt, lost, timer } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final(silence(1000));
    session().listener.closed(failure('Network'));
    await stream.push(audio(400), RATE);
    await timer.advance(FIRST_REOPEN_MS);
    sessionAt(1).listener.closed(failure('KeyInvalid'));
    expect(lost[1]).toEqual({ error: failure('KeyInvalid'), lostMs: 400 });
    await timer.advance(LAST_REOPEN_MS * 3);
    expect(provider.sessions).toHaveLength(2);
    expect(await drain(stream)).toEqual({ lostMs: 400 });
  });

  it('opens nothing after the stream is disposed while it waits to reopen', async () => {
    const { provider, stream, session, lost, timer } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.closed(failure('Network'));
    await stream.push(audio(200), RATE);
    await stream.dispose();
    await timer.advance(LAST_REOPEN_MS * 3);
    expect(provider.sessions).toHaveLength(1);
    expect(lost).toHaveLength(2);
    expect(lost[1]?.error).toBeInstanceOf(TranscriptionCancelledError);
    expect(lost[1]?.lostMs).toBe(200);
    await stream.push(audio(200), RATE);
    expect(provider.sessions).toHaveLength(1);
    expect(await drain(stream)).toEqual({ lostMs: 1200 });
  });

  it('opens nothing after the pass is cancelled while it waits to reopen', async () => {
    const cancel = new CancelSource();
    const { provider, stream, session, timer } = await open({ cancel: cancel.signal });
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.closed(failure('Network'));
    cancel.cancel();
    await timer.advance(LAST_REOPEN_MS * 3);
    expect(provider.sessions).toHaveLength(1);
    expect(await drain(stream)).toEqual({ lostMs: 1000 });
  });

  it('ends a Stop that comes while it waits to reopen at once, without opening a session', async () => {
    const { provider, stream, session, timer } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final(silence(1000));
    session().listener.closed(failure('Network'));
    // Nothing was lost and nothing waits: the draft is still the whole take.
    expect(await drain(stream)).toEqual({ lostMs: 0 });
    await timer.advance(LAST_REOPEN_MS * 3);
    expect(provider.sessions).toHaveLength(1);
  });

  it('ignores what a session that was given up says afterwards', async () => {
    const { stream, session, sessionAt, lost, timer } = await open();
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.closed(failure('Network'));
    await timer.advance(FIRST_REOPEN_MS);
    sessionAt(1).listener.opened();
    session().listener.final(said('tarde', 0, 400));
    session().listener.closed(failure('KeyInvalid'));
    expect(await stream.pullAvailable()).toEqual([]);
    expect(lost).toHaveLength(1);
    await stream.push(audio(100), RATE);
    expect(sessionAt(1).sentSamples).toBe(100);
  });

  it('counts the frame being sent as lost and reopens when the session drops inside send', async () => {
    const { provider, stream, session, lost, timer } = await open();
    await stream.push(audio(100), RATE);
    session().listener.opened();
    session().listener.final(silence(100));
    session().send = () => {
      session().listener.closed(failure('Network'));
    };
    await stream.push(audio(200), RATE);
    expect(lost).toEqual([{ error: failure('Network'), lostMs: 200 }]);
    await timer.advance(FIRST_REOPEN_MS);
    expect(provider.sessions).toHaveLength(2);
  });
});

describe('StreamingSpeechEngine failures and cancel', () => {
  it.each(['KeyMissing', 'KeyInvalid', 'QuotaExceeded', 'ModelNotFound'] as const)(
    'reports a session refused with %s before it opened, with the waiting audio lost',
    async (kind) => {
      const { stream, session, lost } = await open();
      await stream.push(audio(700), RATE);
      session().listener.closed(failure(kind));
      expect(lost).toEqual([{ error: failure(kind), lostMs: 700 }]);
      expect((lost[0]?.error as ApiProviderError).kind).toBe(kind);
      await expect(stream.push(audio(300), RATE)).resolves.toBeUndefined();
      expect(await drain(stream)).toEqual({ lostMs: 1000 });
      expect(session().sent).toEqual([]);
    },
  );

  it('ends the session when the pass is cancelled and takes no more audio', async () => {
    const cancel = new CancelSource();
    const { provider, stream, session, lost } = await open({ cancel: cancel.signal });
    await stream.push(audio(1000), RATE);
    session().listener.opened();
    session().listener.final(said('hola', 0, 400));
    cancel.cancel();
    expect(session().closed).toBe(true);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.error).toBeInstanceOf(TranscriptionCancelledError);
    expect(lost[0]?.lostMs).toBe(600);
    await stream.push(audio(500), RATE);
    expect(provider.sessions).toHaveLength(1);
    expect(session().sentSamples).toBe(1000);
    expect(await drain(stream)).toEqual({ lostMs: 600 });
  });

  it('hands the session a cancel signal that fires when the stream ends', async () => {
    const { stream, session } = await open();
    await stream.push(audio(100), RATE);
    expect(session().options.cancel.cancelled).toBe(false);
    await stream.dispose();
    expect(session().options.cancel.cancelled).toBe(true);
  });

  it('opens nothing for a pass cancelled before its first audio', async () => {
    const cancel = new CancelSource();
    const { provider, stream } = await open({ cancel: cancel.signal });
    cancel.cancel();
    await stream.push(audio(100), RATE);
    expect(provider.sessions).toHaveLength(0);
  });

  it('survives a session whose send throws', async () => {
    const { stream, session, lost } = await open();
    await stream.push(audio(100), RATE);
    session().listener.opened();
    session().send = () => {
      throw new Error('socket gone');
    };
    await expect(stream.push(audio(200), RATE)).resolves.toBeUndefined();
    expect(lost).toHaveLength(1);
    expect(await drain(stream)).toEqual({ lostMs: 300 });
  });

  it('counts the frame being sent as lost when the session ends inside send', async () => {
    const { stream, session, lost } = await open();
    await stream.push(audio(100), RATE);
    session().listener.opened();
    session().send = () => {
      session().listener.closed(failure('KeyInvalid'));
    };
    await stream.push(audio(200), RATE);
    expect(lost).toEqual([{ error: failure('KeyInvalid'), lostMs: 300 }]);
    expect(await drain(stream)).toEqual({ lostMs: 300 });
  });

  it('disposes twice without harm', async () => {
    const { stream, recognizer } = await open();
    await stream.dispose();
    await stream.dispose();
    await recognizer.dispose();
  });
});
