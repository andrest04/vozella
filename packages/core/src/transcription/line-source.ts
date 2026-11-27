import {
  isTranscriptHeader,
  parseCommittedLineEnd,
  parseCommittedLineStart,
} from './committed-line';
import { LOCAL_SPEAKER_MIN_SHARE } from './local-speaker';

/** Who spoke a committed line: the local user (microphone), the others, or no way to tell. */
export type LineSource = 'self' | 'others' | 'unknown';

/** A line is the local user's when at least this share of its span is microphone speech. */
export const LINE_SELF_MIN_SHARE = LOCAL_SPEAKER_MIN_SHARE;

/**
 * Decides who spoke a committed line from the microphone share of its stamp span. The speaker
 * tag is ignored on purpose: it exists only while speaker labels run, and the same rule must
 * hold with labels on or off. `share` answers null when no microphone levels are known.
 */
export function classifyCommittedLine(
  line: string,
  share: (startMs: number, endMs: number) => number | null,
): LineSource {
  if (isTranscriptHeader(line)) return 'unknown';
  const startMs = parseCommittedLineStart(line);
  const endMs = parseCommittedLineEnd(line);
  if (startMs === null || endMs === null) return 'unknown';
  const value = share(startMs, endMs);
  if (value === null) return 'unknown';
  return value >= LINE_SELF_MIN_SHARE ? 'self' : 'others';
}
