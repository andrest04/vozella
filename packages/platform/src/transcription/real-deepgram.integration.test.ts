/**
 * Real-provider proof of the Deepgram adapters: the prerecorded client and the live session behind
 * the streaming speech engine, built by the same factories the app uses. It sends one short WAV to
 * Deepgram three times (one upload, two live streams) and costs well under a cent of billed audio
 * on the account of the key given.
 *
 *   VOZELLA_REAL_STT=1 pnpm --filter @vozella/platform exec vitest run real-deepgram
 *
 * - The rejected-key tests need nothing else: they prove the endpoints, the request shapes up to
 *   authentication, and the failure mapping (the live one through the key check of a socket that
 *   never opens).
 * - The other tests also need `VOZELLA_REAL_STT_WAV` (a mono PCM16 WAV with at least five seconds
 *   of speech) and `VOZELLA_REAL_STT_DEEPGRAM_KEY`; without both they are skipped.
 *   `VOZELLA_REAL_STT_LANGUAGE` (default `en-US`) is the app language tag sent.
 * - The live tests run at the speed of speech, and the paused one waits twelve seconds on purpose
 *   (longer than the ten after which Deepgram closes a stream that hears nothing), so the file
 *   takes about half a minute. The key is never printed: every message shown is scrubbed of it.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiProviderError,
  CancelSource,
  isApiProviderError,
  readSettings,
  StreamingSpeechEngine,
  type AsrResult,
  type AsrStream,
  type AsrStreamCoverage,
  type SpeechToTextResult,
} from '@vozella/core';
import {
  createCloudSpeechToTextClient,
  createStreamingSpeechProvider,
} from './cloud-speech-factory';
import {
  pcmMs,
  readMonoPcm16,
  realSttEnabled,
  realSttLanguage as language,
  realSttWavPath as wavPath,
  tone,
  type Pcm,
} from './real-stt-test-kit';
import { systemSpeechTimer } from './transcription-runtime';

const realKey = (process.env.VOZELLA_REAL_STT_DEEPGRAM_KEY ?? '').trim();
const UNKNOWN_KEY = 'vozella-not-a-real-key';
const canTranscribe = realKey !== '' && wavPath !== '';

/** The audio of one live frame, as the capture hands it over. */
const FRAME_MS = 100;
/** Deepgram closes a stream that gets no audio and no KeepAlive for ten seconds. */
const PAUSE_MS = 12_000;

const choice = { kind: 'Deepgram', settings: readSettings({}) } as const;
const keysOf = (key: string) => ({ get: () => Promise.resolve(key) });

/** A message that is safe to print or assert on: the real key never appears in it. */
const scrubbed = (message: string): string =>
  realKey === '' ? message : message.split(realKey).join('[key]');

/** What a failure was, without anything a provider or a socket might have echoed back. */
const describeFailure = (error: unknown): string =>
  isApiProviderError(error)
    ? `${error.kind}: ${scrubbed(error.message)}`
    : scrubbed(error instanceof Error ? error.message : String(error));

const report = (facts: Readonly<Record<string, unknown>>): void => {
  // The facts the fakes cannot show: printed so a person can read them.
  process.stdout.write(`${scrubbed(JSON.stringify(facts, null, 2))}\n`);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** Lower-case words without punctuation, to compare two transcripts loosely. */
const bareWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

interface Loss {
  readonly error: unknown;
  readonly lostMs: number;
}

interface LiveTake {
  readonly stream: AsrStream;
  readonly losses: Loss[];
  /** Every result pulled so far, with the wall-clock time it was pulled at. */
  readonly results: { readonly atMs: number; readonly result: AsrResult }[];
  /** Milliseconds since the first frame was pushed. */
  elapsedMs(): number;
  /** Pushes `pcm` from `fromMs` to `toMs` in frames, each at the moment it would be captured. */
  speak(pcm: Pcm, fromMs: number, toMs: number): Promise<void>;
  pull(): Promise<void>;
}

/** A live pass built as the app builds it: the factory's provider behind the streaming engine. */
async function startLiveTake(key: string): Promise<LiveTake> {
  const provider = createStreamingSpeechProvider(
    { keys: keysOf(key), timer: systemSpeechTimer },
    choice,
  );
  if (provider === null) throw new Error('Deepgram has no streaming provider.');
  const losses: Loss[] = [];
  const engine = new StreamingSpeechEngine({
    provider,
    timer: systemSpeechTimer,
    onLost: (error, lostMs) => losses.push({ error, lostMs }),
  });
  const recognizer = await engine.createRecognizer({ latency: 'live' });
  const stream = await recognizer.startStream({
    language,
    interimResults: true,
    diarization: false,
  });
  const results: LiveTake['results'] = [];
  let startedAt = 0;
  const elapsedMs = (): number => (startedAt === 0 ? 0 : performance.now() - startedAt);
  const pull = async (): Promise<void> => {
    for (const result of await stream.pullAvailable()) results.push({ atMs: elapsedMs(), result });
  };
  return {
    stream,
    losses,
    results,
    elapsedMs,
    pull,
    speak: async (pcm, fromMs, toMs) => {
      const frame = Math.round((FRAME_MS * pcm.sampleRate) / 1000);
      const first = Math.round((fromMs * pcm.sampleRate) / 1000);
      const last = Math.min(pcm.samples.length, Math.round((toMs * pcm.sampleRate) / 1000));
      const spokenFrom = performance.now();
      for (let at = first; at < last; at += frame) {
        // A frame exists once its last sample was heard.
        const end = Math.min(last, at + frame);
        await sleep(spokenFrom + ((end - first) * 1000) / pcm.sampleRate - performance.now());
        if (startedAt === 0) startedAt = performance.now();
        await stream.push(pcm.samples.subarray(at, end), pcm.sampleRate);
        await pull();
      }
    },
  };
}

/** Finishes the take and waits for its last results, as Stop does. */
function drain(take: LiveTake): Promise<AsrStreamCoverage> {
  if (take.stream.drain === undefined) throw new Error('The streaming engine must drain.');
  return take.stream.drain();
}

const finalsOf = (take: LiveTake): AsrResult[] =>
  take.results.map((entry) => entry.result).filter((result) => result.isFinal);

let uploaded: Promise<SpeechToTextResult> | null = null;
/** The WAV through the prerecorded endpoint, uploaded once for the tests that read it. */
function prerecorded(pcm: Pcm): Promise<SpeechToTextResult> {
  uploaded ??= createCloudSpeechToTextClient(
    { keys: keysOf(realKey), timeoutMs: 60_000 },
    choice,
  ).transcribe({ ...pcm, language }, new CancelSource().signal);
  return uploaded;
}

describe.skipIf(!realSttEnabled)('the real Deepgram endpoints', () => {
  it('the prerecorded endpoint rejects a key it does not know as KeyInvalid', async () => {
    const failure = await createCloudSpeechToTextClient(
      { keys: keysOf(UNKNOWN_KEY), timeoutMs: 60_000 },
      choice,
    )
      .transcribe({ ...tone(), language }, new CancelSource().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ApiProviderError);
    expect((failure as ApiProviderError).kind).toBe('KeyInvalid');
    expect((failure as ApiProviderError).message).not.toContain(UNKNOWN_KEY);
  }, 60_000);

  it('a live session with a key it does not know ends as KeyInvalid and counts its audio as lost', async () => {
    const take = await startLiveTake(UNKNOWN_KEY);
    const audio = tone();

    const pushedAt = performance.now();
    await take.stream.push(audio.samples, audio.sampleRate);
    const coverage = await drain(take);
    const refusedAfterMs = Math.round(performance.now() - pushedAt);
    await take.pull();
    await take.stream.dispose();

    report({ test: 'live rejected key', refusedAfterMs });
    expect(take.losses).toHaveLength(1);
    const failure = take.losses[0]?.error;
    expect(failure).toBeInstanceOf(ApiProviderError);
    expect((failure as ApiProviderError).kind).toBe('KeyInvalid');
    expect((failure as ApiProviderError).message).not.toContain(UNKNOWN_KEY);
    expect(coverage.lostMs).toBeCloseTo(pcmMs(audio), 3);
    expect(take.results).toEqual([]);
  }, 60_000);

  it.skipIf(!canTranscribe)(
    'the prerecorded endpoint transcribes speech with timed words',
    async () => {
      const pcm = readMonoPcm16(wavPath);
      const audioMs = pcmMs(pcm);
      const startedAt = performance.now();

      const result = await prerecorded(pcm);

      report({
        test: 'prerecorded',
        audioMs: Math.round(audioMs),
        answeredInMs: Math.round(performance.now() - startedAt),
        durationMs: result.durationMs,
        text: result.text,
        wordCount: result.words.length,
        words: result.words.slice(0, 8),
      });
      expect(result.text.trim()).not.toBe('');
      expect(result.words.length).toBeGreaterThan(0);
      expect(Math.abs(result.durationMs - audioMs)).toBeLessThan(250);
      let previousStart = 0;
      for (const word of result.words) {
        expect(word.text).toBe(word.text.trim());
        expect(word.text).not.toBe('');
        expect(word.startMs).toBeGreaterThanOrEqual(previousStart);
        expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
        expect(word.endMs).toBeLessThanOrEqual(audioMs + 250);
        previousStart = word.startMs;
      }
      // The words are the transcript, not a different reading of the audio.
      expect(bareWords(result.words.map((word) => word.text).join(' '))).toEqual(
        bareWords(result.text),
      );
    },
    90_000,
  );

  it.skipIf(!canTranscribe)(
    'a live stream gives interim and final results as it is spoken and drains without loss',
    async () => {
      const pcm = readMonoPcm16(wavPath);
      const audioMs = pcmMs(pcm);
      const take = await startLiveTake(realKey);

      await take.speak(pcm, 0, audioMs);
      const spokenMs = take.elapsedMs();
      const beforeDrain = take.results.length;
      const coverage = await drain(take);
      const drainMs = take.elapsedMs() - spokenMs;
      await take.pull();
      await take.stream.dispose();

      const finals = finalsOf(take);
      const interims = take.results.filter((entry) => !entry.result.isFinal);
      const committed = finals.map((result) => result.transcript).join(' ');
      const words = finals.flatMap((result) => result.words);
      // How long after its last word was spoken a result could be pulled (frames are 100 ms).
      const lags = take.results
        .slice(0, beforeDrain)
        .map((entry) => Math.round(entry.atMs - (entry.result.words.at(-1)?.endMs ?? 0)));
      const upload = await prerecorded(pcm);
      const spoken = new Set(bareWords(committed));
      const expected = new Set(bareWords(upload.text));
      const shared = [...expected].filter((word) => spoken.has(word));
      report({
        test: 'live stream',
        audioMs: Math.round(audioMs),
        firstResultAtMs: Math.round(take.results[0]?.atMs ?? -1),
        interimCount: interims.length,
        finalCount: finals.length,
        resultsWhileSpeaking: beforeDrain,
        lagMs: { min: Math.min(...lags), max: Math.max(...lags) },
        drainMs: Math.round(drainMs),
        lostMs: coverage.lostMs,
        losses: take.losses.map((loss) => describeFailure(loss.error)),
        committed,
        prerecorded: upload.text,
        sharedWords: shared.length,
        distinctPrerecordedWords: expected.size,
      });

      expect(take.losses).toEqual([]);
      expect(coverage.lostMs).toBe(0);
      // The production drain gives up after 25 s; a healthy one is a matter of a second or two.
      expect(drainMs).toBeLessThan(10_000);
      // Text appeared while the audio was still being spoken, not only at the drain.
      expect(interims.length).toBeGreaterThan(0);
      expect(take.results.slice(0, beforeDrain).some((entry) => entry.result.isFinal)).toBe(true);
      expect(take.results[0]?.atMs).toBeLessThan(audioMs);
      expect(committed.trim()).not.toBe('');
      let previousStart = 0;
      for (const word of words) {
        expect(word.startMs).toBeGreaterThanOrEqual(previousStart);
        expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
        expect(word.endMs).toBeLessThanOrEqual(audioMs + 250);
        previousStart = word.startMs;
      }
      // The same audio through the other endpoint: loosely the same words.
      expect(shared.length).toBeGreaterThanOrEqual(Math.ceil(expected.size * 0.6));
    },
    90_000,
  );

  it.skipIf(!canTranscribe)(
    'a live stream that hears nothing for twelve seconds stays open and loses nothing',
    async () => {
      const pcm = readMonoPcm16(wavPath);
      const audioMs = pcmMs(pcm);
      expect(audioMs, 'the WAV must be at least five seconds').toBeGreaterThanOrEqual(5_000);
      const take = await startLiveTake(realKey);

      await take.speak(pcm, 0, 1_000);
      await sleep(PAUSE_MS);
      await take.pull();
      const lossesInPause = take.losses.length;
      const pulledBeforeResume = take.results.length;
      await take.speak(pcm, 1_000, audioMs);
      const coverage = await drain(take);
      await take.pull();
      await take.stream.dispose();

      const afterPause = take.results
        .slice(pulledBeforeResume)
        .map((entry) => entry.result)
        .filter((result) => result.isFinal);
      report({
        test: 'paused live stream',
        pauseMs: PAUSE_MS,
        lostMs: coverage.lostMs,
        losses: take.losses.map((loss) => describeFailure(loss.error)),
        finalsAfterPause: afterPause.length,
        firstWordAfterPause: afterPause[0]?.words[0] ?? null,
        committed: finalsOf(take)
          .map((result) => result.transcript)
          .join(' '),
      });

      expect(lossesInPause).toBe(0);
      expect(take.losses).toEqual([]);
      expect(coverage.lostMs).toBe(0);
      // The session that was open before the pause is the one that answered after it: its clock
      // went on from the audio it had already heard instead of starting again at zero.
      expect(afterPause.length).toBeGreaterThan(0);
      const lastWord = afterPause.at(-1)?.words.at(-1);
      expect(lastWord?.endMs).toBeGreaterThan(audioMs / 2);
      expect(lastWord?.endMs).toBeLessThanOrEqual(audioMs + 250);
    },
    90_000,
  );
});
