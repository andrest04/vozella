import { describe, expect, it } from 'vitest';
import type { AsrResult, AsrWord } from './asr-types';
import { StreamingTranscriptAccumulator } from './accumulator';
import { extractCommittedBody } from './committed-line';
import { LOCAL_SPEAKER_MIN_SHARE, LOCAL_SPEAKER_TAG, markLocalSpeaker } from './local-speaker';
import { MicActivityTimeline } from './mic-activity';
import { polishKeepsStructure } from './polish';
import { LOCAL_SPEAKER_LABEL, formatLine } from './stamp-format';

const w = (startMs: number, endMs: number, speakerTag: number, text: string | null = null) =>
  ({ startMs, endMs, speakerTag, text }) satisfies AsrWord;
const tags = (words: readonly AsrWord[]): number[] => words.map((word) => word.speakerTag);
/** The local user spoke from 1 s to 2 s. */
const mic = new MicActivityTimeline([{ startMs: 1000, endMs: 2000 }]);

describe('markLocalSpeaker', () => {
  it('needs most of a word inside the microphone speech', () => {
    expect(LOCAL_SPEAKER_MIN_SHARE).toBe(0.5);
  });

  it('labels words spoken into the microphone as the local speaker', () => {
    const words = [w(0, 400, 1), w(1000, 1400, 1), w(1500, 1900, 2), w(2500, 2900, 1)];
    expect(tags(markLocalSpeaker(words, mic))).toEqual([
      1,
      LOCAL_SPEAKER_TAG,
      LOCAL_SPEAKER_TAG,
      1,
    ]);
  });

  it('decides partial overlaps by the share of the word inside the microphone speech', () => {
    // 600 of 800 ms inside: local. 200 of 800 ms inside: kept.
    const words = [w(1400, 2200, 1), w(1800, 2600, 2), w(600, 1000, 3)];
    expect(tags(markLocalSpeaker(words, mic))).toEqual([LOCAL_SPEAKER_TAG, 2, 3]);
  });

  it('fills words Sortformer left untagged when the microphone carried them', () => {
    const words = [w(1100, 1300, 0), w(3000, 3200, 0)];
    expect(tags(markLocalSpeaker(words, mic))).toEqual([LOCAL_SPEAKER_TAG, 0]);
  });

  it('returns the same words when there is no microphone activity (legacy recording)', () => {
    const words = [w(1000, 1400, 1)];
    expect(markLocalSpeaker(words, null)).toBe(words);
    expect(markLocalSpeaker(words, new MicActivityTimeline([]))).toBe(words);
  });

  it('never mutates its input', () => {
    const words = [w(1000, 1400, 1)];
    markLocalSpeaker(words, mic);
    expect(words[0]?.speakerTag).toBe(1);
  });
});

describe('the local speaker label', () => {
  it('is written as [ You ], never as a speaker number', () => {
    expect(LOCAL_SPEAKER_LABEL).toBe('You');
    expect(formatLine(0, 1000, 'Hola', LOCAL_SPEAKER_TAG)).toBe('[00:00.00-00:01.00] [ You ] Hola');
  });

  it('is stripped from the spoken text like a speaker number', () => {
    expect(extractCommittedBody('[00:00.00-00:01.00] [ You ] Hola')).toBe('Hola');
    expect(extractCommittedBody('* [00:00.00-00:01.00] [ You ] Hola')).toBe('Hola');
  });

  it('must survive polish', () => {
    const original = '[00:00.00-00:01.00] [ You ] hola';
    expect(polishKeepsStructure(original, '[00:00.00-00:01.00] [ You ] Hola.')).toBe(true);
    expect(polishKeepsStructure(original, '[00:00.00-00:01.00] Hola.')).toBe(false);
    expect(polishKeepsStructure(original, '[00:00.00-00:01.00] [ Speaker-1 ] Hola.')).toBe(false);
  });
});

describe('StreamingTranscriptAccumulator with microphone activity', () => {
  const words = [
    w(0, 400, 1, 'Hello'),
    w(400, 800, 1, 'there'),
    w(1000, 1400, 1, 'Hi'),
    w(1400, 1900, 0, 'everyone'),
  ];
  const final: AsrResult = {
    isFinal: true,
    transcript: 'Hello there Hi everyone',
    audioProcessedSeconds: 2,
    words,
  };

  it('splits the local user into their own [ You ] line', () => {
    const acc = new StreamingTranscriptAccumulator(null, { micActivity: mic });
    acc.apply(final);
    expect(acc.committedText).toBe(
      [
        formatLine(0, 800, 'Hello there', 1),
        formatLine(1000, 1900, 'Hi everyone', LOCAL_SPEAKER_TAG),
      ].join('\n'),
    );
  });

  it('keeps today’s lines without microphone activity', () => {
    const acc = new StreamingTranscriptAccumulator(null);
    acc.apply(final);
    expect(acc.committedText).toBe(formatLine(0, 1900, 'Hello there Hi everyone', 1));
  });

  it('labels a result Sortformer left wholly untagged when the microphone carried it', () => {
    const untagged: AsrResult = {
      isFinal: true,
      transcript: 'Hi everyone',
      audioProcessedSeconds: 2,
      words: [w(1000, 1400, 0, 'Hi'), w(1400, 1900, 0, 'everyone')],
    };
    const acc = new StreamingTranscriptAccumulator(null, { micActivity: mic });
    acc.apply(untagged);
    expect(acc.committedText).toBe(formatLine(1000, 1900, 'Hi everyone', LOCAL_SPEAKER_TAG));
  });
});
