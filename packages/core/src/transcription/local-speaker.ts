import type { AsrWord } from './asr-types';
import type { MicActivity } from './mic-activity';

/**
 * The speaker tag of the local user: words spoken into the microphone. Sortformer numbers its
 * speakers 1 to 4, so this value never comes from the engine. It lives only between the word
 * timings and the stamp formatter, which writes it as `[ You ]`; no number reaches the text.
 */
export const LOCAL_SPEAKER_TAG = Number.MAX_SAFE_INTEGER;

/** A word is the local user's when at least this share of it is microphone speech. */
export const LOCAL_SPEAKER_MIN_SHARE = 0.5;

/**
 * Gives the local speaker tag to every word the microphone dominated, tagged or not, so the
 * local user is named reliably and untagged words they spoke are filled. Other words keep their
 * Sortformer tag. Runs before smoothing, which then treats the local user like any speaker.
 *
 * Returns the same array when nothing changes (no activity, a legacy recording). Never mutates.
 */
export function markLocalSpeaker(
  words: readonly AsrWord[],
  activity: MicActivity | null,
): readonly AsrWord[] {
  if (activity === null) return words;
  const marked = words.map((word) =>
    word.speakerTag !== LOCAL_SPEAKER_TAG &&
    activity.dominantShare(word.startMs, word.endMs) >= LOCAL_SPEAKER_MIN_SHARE
      ? { ...word, speakerTag: LOCAL_SPEAKER_TAG }
      : word,
  );
  return marked.every((word, i) => word === words[i]) ? words : marked;
}
