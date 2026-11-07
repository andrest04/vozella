import type { AsrWord } from './asr-types';

/** Silence between words that starts a new idea line for the same speaker. */
export const IDEA_PAUSE_MS = 500;

/**
 * Sortformer tags every word on its own, so a speaker change for a single short word in the
 * middle of a sentence is usually flicker, not a turn. A run of fewer words than this...
 */
export const MIN_SPEAKER_RUN_WORDS = 2;
/** ...that also lasts less than this (first word start to last word end) is absorbed. */
export const MIN_SPEAKER_RUN_MS = 500;

const UNTAGGED = 0;

interface Run {
  /** Inclusive word index. */
  readonly from: number;
  /** Exclusive word index. */
  readonly to: number;
  readonly tag: number;
  readonly durationMs: number;
}

/**
 * Cleans per-word speaker tags before lines are built (spec 3.6, diarization smoothing).
 *
 * Works inside pause-free runs only (words closer than {@link IDEA_PAUSE_MS}), so nothing is
 * carried or merged across an idea pause, which is where real turns usually change:
 * 1. An untagged word takes the previous tagged word's speaker, or the next one when it leads.
 *    A run with no tagged word stays untagged.
 * 2. A speaker run shorter than {@link MIN_SPEAKER_RUN_WORDS} words and
 *    {@link MIN_SPEAKER_RUN_MS} joins the surrounding speaker when both neighbors agree, otherwise
 *    the longer neighbor. Consecutive short runs are treated as one group.
 *
 * Returns the same array when nothing changes (no diarization, a single speaker). Never mutates.
 */
export function smoothSpeakerTags(words: readonly AsrWord[]): readonly AsrWord[] {
  if (!words.some((word) => word.speakerTag > UNTAGGED)) return words;
  const tags = words.map((word) => word.speakerTag);
  for (const [from, to] of pauseFreeRuns(words)) {
    fillUntagged(tags, from, to);
    absorbFlicker(words, tags, from, to);
  }
  if (tags.every((tag, i) => tag === words[i]?.speakerTag)) return words;
  return words.map((word, i) => {
    const tag = tags[i] ?? word.speakerTag;
    return tag === word.speakerTag ? word : { ...word, speakerTag: tag };
  });
}

/** Most frequent tag above zero; a tie goes to the speaker heard first. Zero when none. */
export function majoritySpeakerTag(words: readonly AsrWord[]): number {
  const counts = new Map<number, number>();
  for (const word of words) {
    if (word.speakerTag > UNTAGGED) {
      counts.set(word.speakerTag, (counts.get(word.speakerTag) ?? 0) + 1);
    }
  }
  let best = UNTAGGED;
  let bestCount = 0;
  // Map iteration follows insertion order, so the first speaker heard wins a tie.
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
}

/** `[from, to)` index ranges of words separated by less than an idea pause. */
function pauseFreeRuns(words: readonly AsrWord[]): [number, number][] {
  const ranges: [number, number][] = [];
  let from = 0;
  for (let i = 1; i <= words.length; i += 1) {
    const previous = words[i - 1];
    const current = words[i];
    const paused =
      current === undefined ||
      (previous !== undefined && current.startMs - previous.endMs >= IDEA_PAUSE_MS);
    if (paused) {
      ranges.push([from, i]);
      from = i;
    }
  }
  return ranges;
}

function fillUntagged(tags: number[], from: number, to: number): void {
  let firstTagged = -1;
  let last = UNTAGGED;
  for (let i = from; i < to; i += 1) {
    const tag = tags[i] ?? UNTAGGED;
    if (tag > UNTAGGED) {
      if (firstTagged < 0) firstTagged = i;
      last = tag;
    } else if (last > UNTAGGED) {
      tags[i] = last;
    }
  }
  if (firstTagged < 0) return;
  const leading = tags[firstTagged] ?? UNTAGGED;
  for (let i = from; i < firstTagged; i += 1) tags[i] = leading;
}

function absorbFlicker(words: readonly AsrWord[], tags: number[], from: number, to: number): void {
  const runs = speakerRuns(words, tags, from, to);
  if (runs.length < 2) return;
  let i = 0;
  while (i < runs.length) {
    // A group is a maximal stretch of consecutive short runs, absorbed together.
    const group: Run[] = [];
    for (let run = runs[i]; run !== undefined && isShort(run); run = runs[i + group.length]) {
      group.push(run);
    }
    if (group.length === 0) {
      i += 1;
      continue;
    }
    const tag = absorbingTag(runs[i - 1], runs[i + group.length]);
    if (tag !== null) {
      for (const short of group) {
        for (let j = short.from; j < short.to; j += 1) tags[j] = tag;
      }
    }
    i += group.length;
  }
}

function speakerRuns(
  words: readonly AsrWord[],
  tags: readonly number[],
  from: number,
  to: number,
): Run[] {
  const runs: Run[] = [];
  let start = from;
  for (let i = from + 1; i <= to; i += 1) {
    if (i < to && tags[i] === tags[start]) continue;
    const first = words[start];
    const last = words[i - 1];
    runs.push({
      from: start,
      to: i,
      tag: tags[start] ?? UNTAGGED,
      durationMs: first && last ? last.endMs - first.startMs : 0,
    });
    start = i;
  }
  return runs;
}

function isShort(run: Run): boolean {
  return run.to - run.from < MIN_SPEAKER_RUN_WORDS && run.durationMs < MIN_SPEAKER_RUN_MS;
}

/** Both neighbors agree: theirs. Otherwise the longer one, the previous on a tie. */
function absorbingTag(previous: Run | undefined, next: Run | undefined): number | null {
  if (previous === undefined) return next === undefined ? null : next.tag;
  if (next === undefined) return previous.tag;
  if (previous.tag === next.tag) return previous.tag;
  return next.durationMs > previous.durationMs ? next.tag : previous.tag;
}
