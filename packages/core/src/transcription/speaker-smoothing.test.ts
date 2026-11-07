import { describe, expect, it } from 'vitest';
import type { AsrWord } from './asr-types';
import {
  IDEA_PAUSE_MS,
  MIN_SPEAKER_RUN_MS,
  MIN_SPEAKER_RUN_WORDS,
  majoritySpeakerTag,
  smoothSpeakerTags,
} from './speaker-smoothing';

const w = (
  startMs: number,
  endMs: number,
  speakerTag: number,
  text: string | null = null,
): AsrWord => ({
  startMs,
  endMs,
  speakerTag,
  text,
});
const tags = (words: readonly AsrWord[]): number[] => words.map((word) => word.speakerTag);

/** Back-to-back words of `ms` each, no gaps, with the given tags. */
const contiguous = (ms: number, ...speakerTags: number[]): AsrWord[] =>
  speakerTags.map((tag, i) => w(i * ms, (i + 1) * ms, tag));

describe('smoothSpeakerTags', () => {
  it('documents its thresholds', () => {
    expect(MIN_SPEAKER_RUN_WORDS).toBe(2);
    expect(MIN_SPEAKER_RUN_MS).toBe(500);
    expect(IDEA_PAUSE_MS).toBe(500);
  });

  describe('identity paths', () => {
    it('returns the same words when nothing is tagged (no diarization)', () => {
      const words = contiguous(200, 0, 0, 0);
      expect(smoothSpeakerTags(words)).toBe(words);
    });

    it('returns the same words for a single speaker', () => {
      const words = contiguous(200, 2, 2, 2, 2);
      expect(smoothSpeakerTags(words)).toBe(words);
    });

    it('returns an empty list unchanged', () => {
      expect(smoothSpeakerTags([])).toEqual([]);
    });

    it('does not mutate the input words', () => {
      const words = contiguous(200, 1, 0, 1);
      smoothSpeakerTags(words);
      expect(tags(words)).toEqual([1, 0, 1]);
    });
  });

  describe('tag-0 fill', () => {
    it('fills an untagged word from the previous tagged word', () => {
      expect(tags(smoothSpeakerTags(contiguous(300, 1, 1, 0, 2, 2)))).toEqual([1, 1, 1, 2, 2]);
    });

    it('fills leading untagged words from the next tagged word', () => {
      expect(tags(smoothSpeakerTags(contiguous(300, 0, 0, 2, 2)))).toEqual([2, 2, 2, 2]);
    });

    it('does not fill across an idea pause', () => {
      const words = [w(0, 400, 1), w(400, 800, 1), w(800 + IDEA_PAUSE_MS, 1600, 0)];
      expect(tags(smoothSpeakerTags(words))).toEqual([1, 1, 0]);
    });

    it('leaves a pause-free run with no tagged word untagged', () => {
      const words = [w(0, 400, 1), w(1000, 1400, 0), w(1400, 1800, 0)];
      expect(tags(smoothSpeakerTags(words))).toEqual([1, 0, 0]);
    });
  });

  describe('flicker', () => {
    it('absorbs a one-word short run between two runs of the same speaker', () => {
      expect(tags(smoothSpeakerTags(contiguous(200, 1, 1, 2, 1, 1)))).toEqual([1, 1, 1, 1, 1]);
    });

    it('absorbs a short run into the longer neighbor when the neighbors disagree', () => {
      const words = [
        w(0, 300, 1),
        w(300, 600, 1),
        w(600, 800, 3),
        w(800, 1500, 2),
        w(1500, 2200, 2),
      ];
      expect(tags(smoothSpeakerTags(words))).toEqual([1, 1, 2, 2, 2]);
    });

    it('absorbs a short run at the edge into its only neighbor', () => {
      expect(tags(smoothSpeakerTags(contiguous(200, 2, 1, 1, 1)))).toEqual([1, 1, 1, 1]);
    });

    it('absorbs consecutive short runs together', () => {
      expect(tags(smoothSpeakerTags(contiguous(150, 1, 1, 1, 3, 4, 1, 1)))).toEqual([
        1, 1, 1, 1, 1, 1, 1,
      ]);
    });

    it('keeps a one-word run that lasts at least the minimum duration', () => {
      const words = [
        w(0, 300, 1),
        w(300, 600, 1),
        w(600, 600 + MIN_SPEAKER_RUN_MS, 2),
        w(1100, 1400, 1),
        w(1400, 1700, 1),
      ];
      expect(tags(smoothSpeakerTags(words))).toEqual([1, 1, 2, 1, 1]);
    });

    it('keeps a short run of two words (a real interjection)', () => {
      expect(tags(smoothSpeakerTags(contiguous(100, 1, 1, 2, 2, 1, 1)))).toEqual([
        1, 1, 2, 2, 1, 1,
      ]);
    });

    it('does not absorb across an idea pause', () => {
      const words = [w(0, 400, 1), w(400, 800, 1), w(800 + IDEA_PAUSE_MS, 1500, 2)];
      expect(tags(smoothSpeakerTags(words))).toEqual([1, 1, 2]);
    });

    it('keeps a short run that is alone in its pause-free run', () => {
      const words = [w(0, 400, 1), w(1000, 1200, 2), w(1800, 2200, 1)];
      expect(tags(smoothSpeakerTags(words))).toEqual([1, 2, 1]);
    });

    it('fills untagged words before measuring runs', () => {
      // The untagged word joins speaker 1, so speaker 2 is a one-word flicker.
      expect(tags(smoothSpeakerTags(contiguous(200, 1, 1, 0, 2, 1, 1)))).toEqual([
        1, 1, 1, 1, 1, 1,
      ]);
      // The untagged word joins speaker 2, so speaker 2 is a two-word run and stays.
      expect(tags(smoothSpeakerTags(contiguous(200, 1, 1, 2, 0, 1, 1)))).toEqual([
        1, 1, 2, 2, 1, 1,
      ]);
    });
  });
});

describe('majoritySpeakerTag', () => {
  it('is the most frequent tag above zero', () => {
    expect(majoritySpeakerTag(contiguous(100, 2, 1, 1, 2, 1))).toBe(1);
  });

  it('ignores untagged words', () => {
    expect(majoritySpeakerTag(contiguous(100, 0, 0, 0, 3))).toBe(3);
  });

  it('breaks a tie by the earliest speaker', () => {
    expect(majoritySpeakerTag(contiguous(100, 2, 1, 1, 2))).toBe(2);
  });

  it('is zero when no word is tagged', () => {
    expect(majoritySpeakerTag(contiguous(100, 0, 0))).toBe(0);
    expect(majoritySpeakerTag([])).toBe(0);
  });
});
