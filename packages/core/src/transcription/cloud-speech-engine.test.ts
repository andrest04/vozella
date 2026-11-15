import { describe, expect, it } from 'vitest';
import { CancelSource, type CancelSignal } from '../cancel';
import { ApiProviderError, type ApiFailureKind } from '../summaries/api-failure';
import { StreamingTranscriptAccumulator } from './accumulator';
import type { AsrLatencyProfile, AsrResult, AsrStream } from './asr-types';
import {
  CLOUD_CHUNK_MIN_MS,
  CLOUD_LIVE_CHUNK_TARGET_MS,
  CLOUD_LIVE_MAX_BUFFERED_MS,
  CLOUD_MIN_REQUEST_INTERVAL_MS,
  CLOUD_OFFLINE_CHUNK_TARGET_MS,
  CLOUD_PROMPT_MAX_CHARS,
  CLOUD_QUIET_SEARCH_MS,
  CLOUD_RATE_LIMIT_DEFAULT_WAIT_MS,
  CLOUD_RATE_LIMIT_MAX_RETRIES,
  CLOUD_RATE_LIMIT_MAX_WAIT_MS,
  CLOUD_TRANSIENT_BACKOFF_MS,
  CLOUD_TRANSIENT_MAX_RETRIES,
  CloudSpeechEngine,
  isFatalSpeechFailure,
} from './cloud-speech-engine';
import { TranscriptionCancelledError } from './ports';
import { FakeSpeechTimer, ScriptedSpeechToTextClient } from './test-kit';

/** A low rate keeps the arrays small; the engine works in milliseconds of whatever rate it gets. */
const RATE = 1000;
const ms = (samples: number): number => (samples * 1000) / RATE;

/** `durationMs` of audio at one loudness, with silence in the given ranges. */
function audio(durationMs: number, silences: readonly (readonly [number, number])[] = []) {
  const samples = new Float32Array((durationMs * RATE) / 1000).fill(0.5);
  for (const [from, to] of silences) samples.fill(0, (from * RATE) / 1000, (to * RATE) / 1000);
  return samples;
}

const failure = (kind: ApiFailureKind, retryAfterMs: number | null = null) =>
  new ApiProviderError('Groq', kind, null, undefined, retryAfterMs);

async function open(
  latency: AsrLatencyProfile,
  options: { cancel?: CancelSignal; language?: string } = {},
) {
  const client = new ScriptedSpeechToTextClient();
  const timer = new FakeSpeechTimer();
  const lost: { error: unknown; lostMs: number }[] = [];
  const engine = new CloudSpeechEngine({
    client,
    timer,
    onLost: (error, lostMs) => lost.push({ error, lostMs }),
  });
  const recognizer = await engine.createRecognizer({ latency }, options.cancel);
  const stream = await recognizer.startStream({
    language: options.language ?? 'es-US',
    interimResults: true,
    diarization: false,
  });
  return { client, timer, lost, recognizer, stream };
}

/** Lets the pump take every step it can without more input. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

const drained = async (stream: AsrStream) => {
  if (!stream.drain) throw new Error('the cloud stream must drain');
  const coverage = await stream.drain();
  return { coverage, results: await stream.pullAvailable() };
};

const lengths = (client: ScriptedSpeechToTextClient): number[] =>
  client.requests.map((request) => ms(request.samples.length));

describe('cloud speech engine: cutting pieces', () => {
  it('keeps the policy numbers consistent with the 10 s minimum bill', () => {
    expect(CLOUD_LIVE_CHUNK_TARGET_MS).toBe(15_000);
    expect(CLOUD_OFFLINE_CHUNK_TARGET_MS).toBe(60_000);
    expect(CLOUD_CHUNK_MIN_MS).toBe(10_000);
    expect(CLOUD_LIVE_CHUNK_TARGET_MS - CLOUD_QUIET_SEARCH_MS).toBeGreaterThanOrEqual(
      CLOUD_CHUNK_MIN_MS,
    );
  });

  it('live: sends nothing until the target is buffered, then one piece near the target', async () => {
    const { client, stream } = await open('live');
    await stream.push(audio(14_900), RATE);
    await settle();
    expect(client.requests).toHaveLength(0);
    await stream.push(audio(200), RATE);
    await settle();
    expect(client.requests).toHaveLength(1);
    const [length] = lengths(client);
    expect(length).toBeGreaterThan(CLOUD_LIVE_CHUNK_TARGET_MS - CLOUD_QUIET_SEARCH_MS);
    expect(length).toBeLessThanOrEqual(CLOUD_LIVE_CHUNK_TARGET_MS);
  });

  it('cuts at the quietest point near the end of the window, so a word is not split', async () => {
    const { client, stream } = await open('live');
    await stream.push(audio(16_000, [[12_000, 12_200]]), RATE);
    await settle();
    const [length] = lengths(client);
    expect(length).toBeGreaterThan(12_000);
    expect(length).toBeLessThan(12_200);
  });

  it('never cuts a piece under the minimum: a pause before the search window is ignored', async () => {
    const { client, stream } = await open('live');
    await stream.push(audio(16_000, [[9_000, 9_500]]), RATE);
    await settle();
    const [length] = lengths(client);
    expect(length).toBeGreaterThanOrEqual(CLOUD_CHUNK_MIN_MS);
    expect(length).toBeGreaterThan(CLOUD_LIVE_CHUNK_TARGET_MS - CLOUD_QUIET_SEARCH_MS);
  });

  it('offline: pieces are about a minute long', async () => {
    const { client, stream } = await open('offline');
    await stream.push(audio(69_000), RATE);
    // Under target + minimum nothing is cut yet: the rest could still be a tail too short to bill.
    expect(client.requests).toHaveLength(0);
    await stream.push(audio(2_000), RATE);
    expect(client.requests).toHaveLength(1);
    const [length] = lengths(client);
    expect(length).toBeGreaterThan(CLOUD_OFFLINE_CHUNK_TARGET_MS - CLOUD_QUIET_SEARCH_MS);
    expect(length).toBeLessThanOrEqual(CLOUD_OFFLINE_CHUNK_TARGET_MS);
  });

  it('the final tail is transcribed on drain, however short', async () => {
    const { client, stream } = await open('live');
    await stream.push(audio(3_000), RATE);
    const { coverage, results } = await drained(stream);
    expect(lengths(client)).toEqual([3_000]);
    expect(results.map((result) => result.transcript)).toEqual(['piece0']);
    expect(coverage).toEqual({ lostMs: 0 });
  });

  it('drain joins a tail under the minimum to the piece before it', async () => {
    const { client, stream } = await open('offline');
    await stream.push(audio(59_000), RATE);
    // 59 s + 8 s is under target + minimum: one request of 67 s, not 60 s and a 7 s tail.
    await stream.push(audio(8_000), RATE);
    await settle();
    expect(client.requests).toHaveLength(0);
    await drained(stream);
    expect(lengths(client)).toEqual([67_000]);
  });

  it('drain cuts regular pieces while a tail of at least the minimum is left', async () => {
    const { client, stream } = await open('live');
    client.hold();
    await stream.push(audio(15_000), RATE);
    await stream.push(audio(30_000), RATE);
    const done = drained(stream);
    for (let i = 0; i < 4; i += 1) {
      await settle();
      client.release();
    }
    await done;
    const sent = lengths(client);
    expect(sent.reduce((sum, length) => sum + length, 0)).toBe(45_000);
    for (const length of sent) expect(length).toBeGreaterThanOrEqual(CLOUD_CHUNK_MIN_MS);
  });

  it('drain with nothing buffered sends nothing', async () => {
    const { client, stream } = await open('live');
    const { coverage, results } = await drained(stream);
    expect(client.requests).toHaveLength(0);
    expect(results).toEqual([]);
    expect(coverage).toEqual({ lostMs: 0 });
  });
});

describe('cloud speech engine: results', () => {
  it('word times and audioProcessedSeconds are absolute in the stream', async () => {
    const { client, stream } = await open('live');
    await stream.push(audio(15_000), RATE);
    await stream.push(audio(5_000), RATE);
    const { results } = await drained(stream);
    expect(results).toHaveLength(2);
    const firstLength = lengths(client)[0] ?? 0;
    const [first, second] = results as [AsrResult, AsrResult];
    expect(first.words).toEqual([{ startMs: 100, endMs: 200, speakerTag: 0, text: 'piece0' }]);
    expect(first.audioProcessedSeconds).toBeCloseTo(firstLength / 1000, 5);
    expect(second.words).toEqual([
      { startMs: firstLength + 100, endMs: firstLength + 200, speakerTag: 0, text: 'piece1' },
    ]);
    expect(second.audioProcessedSeconds).toBeCloseTo(20, 5);
    expect(results.every((result) => result.isFinal)).toBe(true);
  });

  it('a silent piece adds no result', async () => {
    const { client, stream } = await open('live');
    client.answer = (_call, request) => ({
      text: '',
      words: [],
      durationMs: ms(request.samples.length),
    });
    await stream.push(audio(4_000), RATE);
    const { results, coverage } = await drained(stream);
    expect(results).toEqual([]);
    expect(coverage).toEqual({ lostMs: 0 });
  });

  it('transcribes strictly in order with one request in flight', async () => {
    const { client, stream } = await open('live');
    client.hold();
    for (let i = 0; i < 4; i += 1) await stream.push(audio(15_000), RATE);
    await settle();
    expect(client.requests).toHaveLength(1);
    const done = drained(stream);
    for (let i = 0; i < 8; i += 1) {
      await settle();
      client.release();
    }
    const { results } = await done;
    expect(client.maxInFlight).toBe(1);
    expect(results.map((result) => result.transcript)).toEqual(
      client.requests.map((_request, call) => `piece${String(call)}`),
    );
    const ends = results.map((result) => result.audioProcessedSeconds);
    expect([...ends].sort((a, b) => a - b)).toEqual(ends);
  });

  it('passes the language and the end of the previous text as the prompt', async () => {
    const { client, stream } = await open('live', { language: 'es-US' });
    const long = `${'palabra '.repeat(100)}final`;
    client.answer = (call, request) => ({
      text: call === 0 ? long : 'next',
      words: [{ text: 'x', startMs: 0, endMs: 10 }],
      durationMs: ms(request.samples.length),
    });
    await stream.push(audio(15_000), RATE);
    await stream.push(audio(15_000), RATE);
    await drained(stream);
    expect(client.requests.length).toBeGreaterThanOrEqual(2);
    expect(client.requests[0]?.language).toBe('es-US');
    expect(client.requests[0]?.prompt ?? null).toBeNull();
    const prompt = client.requests[1]?.prompt ?? '';
    expect(prompt.endsWith('final')).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(CLOUD_PROMPT_MAX_CHARS);
    // Cut at a word: never half of one.
    expect(prompt.startsWith('palabra')).toBe(true);
  });

  it('offline: push waits for the request once a whole piece is buffered', async () => {
    const { client, stream } = await open('offline');
    client.hold();
    let pushed = false;
    const push = stream.push(audio(71_000), RATE).then(() => {
      pushed = true;
    });
    await settle();
    expect(client.requests).toHaveLength(1);
    expect(pushed).toBe(false);
    client.release();
    await push;
    expect(pushed).toBe(true);
  });

  it('live: push never waits for a request', async () => {
    const { client, stream } = await open('live');
    client.hold();
    await stream.push(audio(16_000), RATE);
    await stream.push(audio(16_000), RATE);
    expect(client.requests).toHaveLength(1);
    expect(client.inFlight).toBe(1);
  });

  it('a request starts no sooner than the minimum interval after the one before', async () => {
    const { client, timer, stream } = await open('live');
    await stream.push(audio(15_000), RATE);
    await stream.push(audio(15_000), RATE);
    await drained(stream);
    expect(client.requests.length).toBeGreaterThanOrEqual(2);
    expect(timer.waits).toEqual(client.requests.slice(1).map(() => CLOUD_MIN_REQUEST_INTERVAL_MS));
  });

  it('stamped lines from cloud results have the format of local results', async () => {
    const { client, stream } = await open('live');
    client.answer = (_call, request) => ({
      text: 'hola a todos',
      words: [
        { text: 'hola', startMs: 1_000, endMs: 1_300 },
        { text: 'a', startMs: 1_350, endMs: 1_400 },
        { text: 'todos', startMs: 1_450, endMs: 2_000 },
      ],
      durationMs: ms(request.samples.length),
    });
    await stream.push(audio(15_000), RATE);
    await stream.push(audio(3_000), RATE);
    const { results } = await drained(stream);
    const cloud = new StreamingTranscriptAccumulator(null);
    for (const result of results) cloud.apply(result);

    const firstLength = lengths(client)[0] ?? 0;
    const local = new StreamingTranscriptAccumulator(null);
    for (const offset of [0, firstLength]) {
      local.apply({
        isFinal: true,
        transcript: 'hola a todos',
        audioProcessedSeconds: 0,
        words: [
          { startMs: offset + 1_000, endMs: offset + 1_300, speakerTag: 0, text: 'hola' },
          { startMs: offset + 1_350, endMs: offset + 1_400, speakerTag: 0, text: 'a' },
          { startMs: offset + 1_450, endMs: offset + 2_000, speakerTag: 0, text: 'todos' },
        ],
      });
    }
    expect(cloud.committedText).toBe(local.committedText);
    const lines = cloud.committedText.split('\n');
    expect(lines[0]).toBe('[00:01.00-00:02.00] hola a todos');
    for (const line of lines)
      expect(line).toMatch(/^\[\d{2,}:\d{2}\.\d{2}-\d{2,}:\d{2}\.\d{2}\] \S/);
    // No speaker labels: the endpoint returns no speakers.
    expect(cloud.committedText).not.toContain('Speaker-');
    expect(cloud.committedText).not.toContain('[ You ]');
  });
});

describe('isFatalSpeechFailure', () => {
  it.each(['KeyMissing', 'KeyInvalid', 'QuotaExceeded', 'ModelNotFound'] as const)(
    '%s ends a live pass: waiting cannot fix it',
    (kind) => {
      expect(isFatalSpeechFailure(failure(kind))).toBe(true);
    },
  );

  it.each(['RateLimited', 'Network', 'TimedOut', 'EmptyOutput', 'Unknown'] as const)(
    '%s is a gap, not the end of the pass',
    (kind) => {
      expect(isFatalSpeechFailure(failure(kind))).toBe(false);
    },
  );

  it('is false for anything that is not an API failure', () => {
    expect(isFatalSpeechFailure(new Error('boom'))).toBe(false);
    expect(isFatalSpeechFailure(null)).toBe(false);
  });
});

describe('cloud speech engine: limits and failures', () => {
  it('waits what a rate limit asks, then sends the same piece again', async () => {
    const { client, timer, stream } = await open('offline');
    client.errors = [failure('RateLimited', 7_000)];
    await stream.push(audio(5_000), RATE);
    const { results, coverage } = await drained(stream);
    expect(timer.waits).toContain(7_000);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.samples).toEqual(client.requests[0]?.samples);
    expect(results.map((result) => result.transcript)).toEqual(['piece1']);
    expect(coverage).toEqual({ lostMs: 0 });
  });

  it('a rate limit without a wait uses the default wait', async () => {
    const { client, timer, stream } = await open('offline');
    client.errors = [failure('RateLimited')];
    await stream.push(audio(5_000), RATE);
    await drained(stream);
    expect(timer.waits).toContain(CLOUD_RATE_LIMIT_DEFAULT_WAIT_MS);
  });

  it('gives up on a rate limit after the capped number of retries', async () => {
    const { client, stream } = await open('offline');
    client.errors = Array.from({ length: CLOUD_RATE_LIMIT_MAX_RETRIES + 1 }, () =>
      failure('RateLimited', 1_000),
    );
    await stream.push(audio(5_000), RATE);
    await expect(drained(stream)).rejects.toMatchObject({ kind: 'RateLimited' });
    expect(client.requests).toHaveLength(CLOUD_RATE_LIMIT_MAX_RETRIES + 1);
  });

  it('does not wait out a rate limit longer than the cap (the hourly audio limit)', async () => {
    const { client, timer, stream } = await open('offline');
    client.errors = [failure('RateLimited', CLOUD_RATE_LIMIT_MAX_WAIT_MS + 1)];
    await stream.push(audio(5_000), RATE);
    await expect(drained(stream)).rejects.toMatchObject({ kind: 'RateLimited' });
    expect(client.requests).toHaveLength(1);
    expect(timer.waits).toEqual([]);
  });

  it.each(['Network', 'TimedOut'] as const)(
    'retries %s a bounded number of times with a growing wait',
    async (kind) => {
      const { client, timer, stream } = await open('offline');
      client.errors = Array.from({ length: CLOUD_TRANSIENT_MAX_RETRIES + 1 }, () => failure(kind));
      await stream.push(audio(5_000), RATE);
      await expect(drained(stream)).rejects.toMatchObject({ kind });
      expect(client.requests).toHaveLength(CLOUD_TRANSIENT_MAX_RETRIES + 1);
      expect(timer.waits).toEqual([CLOUD_TRANSIENT_BACKOFF_MS, CLOUD_TRANSIENT_BACKOFF_MS * 2]);
    },
  );

  it('a transient failure that clears is not a failure', async () => {
    const { client, stream } = await open('offline');
    client.errors = [failure('Network')];
    await stream.push(audio(5_000), RATE);
    const { results } = await drained(stream);
    expect(results.map((result) => result.transcript)).toEqual(['piece1']);
  });

  it.each(['QuotaExceeded', 'KeyInvalid', 'KeyMissing', 'ModelNotFound'] as const)(
    'offline: %s is never retried and fails the pass',
    async (kind) => {
      const { client, timer, stream } = await open('offline');
      client.errors = [failure(kind)];
      await stream.push(audio(5_000), RATE);
      await expect(drained(stream)).rejects.toMatchObject({ kind });
      expect(client.requests).toHaveLength(1);
      expect(timer.waits).toEqual([]);
      // The pass is over: more audio is refused with the same failure.
      await expect(stream.push(audio(1_000), RATE)).rejects.toMatchObject({ kind });
    },
  );

  it('offline: a failed piece fails the push that was waiting for it', async () => {
    const { client, stream } = await open('offline');
    client.errors = [failure('KeyInvalid')];
    await expect(stream.push(audio(71_000), RATE)).rejects.toMatchObject({ kind: 'KeyInvalid' });
  });

  it.each(['QuotaExceeded', 'KeyInvalid', 'KeyMissing', 'ModelNotFound'] as const)(
    'live: %s stops the uploads and everything after it is a gap',
    async (kind) => {
      const { client, lost, stream } = await open('live');
      client.errors = [failure(kind)];
      await stream.push(audio(15_000), RATE);
      await settle();
      await stream.push(audio(15_000), RATE);
      await stream.push(audio(2_000), RATE);
      const { coverage, results } = await drained(stream);
      expect(client.requests).toHaveLength(1);
      expect(results).toEqual([]);
      expect(coverage.lostMs).toBe(32_000);
      expect(lost[0]?.error).toMatchObject({ kind });
    },
  );

  it('live: a piece that fails for good is a gap, and the next pieces still arrive', async () => {
    const { client, lost, stream } = await open('live');
    client.errors = [failure('Unknown')];
    await stream.push(audio(15_000), RATE);
    await settle();
    await stream.push(audio(5_000), RATE);
    const { coverage, results } = await drained(stream);
    const firstLength = lengths(client)[0] ?? 0;
    expect(coverage.lostMs).toBe(firstLength);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.lostMs).toBe(firstLength);
    expect(results.map((result) => result.transcript)).toEqual(['piece1']);
    // The piece after the gap keeps its real position.
    expect(results[0]?.words[0]?.startMs).toBe(firstLength + 100);
  });

  it('live: more than the buffer limit waiting is dropped as a gap, oldest first', async () => {
    const { client, stream } = await open('live');
    client.hold();
    await stream.push(audio(15_000), RATE);
    await settle();
    const first = lengths(client)[0] ?? 0;
    // The first piece is in flight; this much more cannot wait.
    const second = 60_000;
    for (let pushedMs = 0; pushedMs < CLOUD_LIVE_MAX_BUFFERED_MS + 2 * second; pushedMs += second) {
      await stream.push(audio(second), RATE);
    }
    const done = drained(stream);
    for (let i = 0; i < 60; i += 1) {
      await settle();
      client.release();
    }
    const { coverage, results } = await done;
    expect(coverage.lostMs).toBeGreaterThan(0);
    const sentMs = lengths(client).reduce((sum, length) => sum + length, 0);
    expect(sentMs - first).toBeLessThanOrEqual(CLOUD_LIVE_MAX_BUFFERED_MS);
    // What was kept is the newest audio, at its real position.
    const total = 15_000 + CLOUD_LIVE_MAX_BUFFERED_MS + 2 * second;
    expect(coverage.lostMs + sentMs).toBe(total);
    expect(results.at(-1)?.audioProcessedSeconds).toBeCloseTo(total / 1000, 5);
  });

  it('cancel aborts the request in flight and ends the pass as cancelled', async () => {
    const cancel = new CancelSource();
    const { client, stream } = await open('offline', { cancel });
    client.hold();
    const push = stream.push(audio(71_000), RATE);
    await settle();
    expect(client.inFlight).toBe(1);
    cancel.cancel();
    await expect(push).rejects.toBeInstanceOf(TranscriptionCancelledError);
    expect(client.cancels[0]?.cancelled).toBe(true);
    expect(client.inFlight).toBe(0);
  });

  it('dispose aborts the request in flight and sends nothing more', async () => {
    const { client, stream } = await open('live');
    client.hold();
    await stream.push(audio(16_000), RATE);
    await settle();
    await stream.dispose();
    expect(client.cancels[0]?.cancelled).toBe(true);
    await stream.push(audio(16_000), RATE);
    await settle();
    expect(client.requests).toHaveLength(1);
  });
});
