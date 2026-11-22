/** The recent part of the committed transcript a live answer reads. */
import {
  isTranscriptHeader,
  parseCommittedLineEnd,
  splitCommittedLines,
} from '../transcription/committed-line';
import { cutTail } from '../text/utf16-cut';

export const DEFAULT_ANSWER_WINDOW_MS = 90_000;
/** A preset overview next to a rolling digest: the digest covers what came before this. */
export const OVERVIEW_WINDOW_WITH_DIGEST_MS = 180_000;
/** A preset overview before any digest exists: as much of the take as one prompt can hold. */
export const OVERVIEW_WINDOW_NO_DIGEST_MS = 600_000;
export const UNSTAMPED_FALLBACK_CHARS = 2500;

export function takeRecentWindow(
  committedText: string | null | undefined,
  windowMs: number = DEFAULT_ANSWER_WINDOW_MS,
): string {
  if (committedText === null || committedText === undefined || committedText === '') return '';
  // One newline kind in the output (the prompt is \n joined), whatever mix came in.
  const lines = splitCommittedLines(committedText);
  const ends = lines.map(parseCommittedLineEnd);
  let latest: number | null = null;
  for (const end of ends) if (end !== null && (latest === null || end > latest)) latest = end;
  // The cut keeps whole surrogate pairs.
  if (latest === null) return cutTail(lines.join('\n'), UNSTAMPED_FALLBACK_CHARS);
  const cutoff = latest - windowMs;
  const inSpan = (end: number | null): boolean => end !== null && end >= cutoff && end <= latest;
  let first = -1;
  let last = -1;
  ends.forEach((end, index) => {
    if (!inSpan(end)) return;
    if (first < 0) first = index;
    last = index;
  });
  if (first < 0) return '';
  const kept: string[] = [];
  lines.forEach((line, index) => {
    if (isTranscriptHeader(line)) return;
    const end = ends[index] ?? null;
    if (end !== null ? inSpan(end) : index >= first && index <= last) kept.push(line);
  });
  return kept.join('\n');
}
