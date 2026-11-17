import type { MeetingListItem } from '../library/meeting';
import { searchMeetings, type MeetingBody } from '../library/meeting-search';
import { foldedWords } from '../library/text-fold';
import { compactMeetingId, MEETING_CAP } from './context-packer';

/** Words shorter than this are noise in a question ("de", "el", "a"), so they do not rank. */
const MIN_TERM_CHARS = 3;
/** Each term costs one pass over the folded text the library already caches. */
const MAX_QUESTION_TERMS = 6;

const recordedMs = (item: MeetingListItem): number => {
  const ms = Date.parse(item.recordedAt);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Newest first, ties by compact id descending: the order the packer uses. */
export const newestFirst = (a: MeetingListItem, b: MeetingListItem): number => {
  const diff = recordedMs(b) - recordedMs(a);
  if (diff !== 0) return diff;
  const ia = compactMeetingId(a.id);
  const ib = compactMeetingId(b.id);
  return ia < ib ? 1 : ia > ib ? -1 : 0;
};

export interface RankInput {
  /** The candidate meetings (already scoped to a project, or all). */
  readonly items: readonly MeetingListItem[];
  readonly question: string;
  /** The library's search source; read lazily, only for the candidates. */
  readonly bodies: (filter: (item: MeetingListItem) => boolean) => AsyncIterable<MeetingBody>;
}

async function hitIds(input: RankInput, query: string, wanted: ReadonlySet<string>) {
  const hits = await searchMeetings({
    bodies: input.bodies((item) => wanted.has(compactMeetingId(item.id))),
    query,
    isStale: () => false,
  });
  return (hits ?? []).map((hit) => hit.meetingId);
}

/**
 * Meeting ids ordered by how well they answer the question, using the library's own search. The
 * search wants every word in one meeting, which a spoken question rarely satisfies, so: meetings
 * holding the whole question come first, then the rest by how many of its words they hold, newest
 * first on a tie. Meetings that match nothing are not listed.
 */
export async function rankMeetingsForQuestion(input: RankInput): Promise<readonly string[]> {
  const terms = [
    ...new Set(foldedWords(input.question).filter((word) => word.length >= MIN_TERM_CHARS)),
  ].slice(0, MAX_QUESTION_TERMS);
  if (terms.length === 0) return [];

  const wanted = new Set(input.items.map((item) => compactMeetingId(item.id)));
  const ordered = [...input.items].sort(newestFirst);
  const position = new Map(ordered.map((item, index) => [compactMeetingId(item.id), index]));
  const key = (id: string): string => compactMeetingId(id);

  const whole = terms.length > 1 ? await hitIds(input, terms.join(' '), wanted) : [];
  const counts = new Map<string, number>();
  for (const term of terms) {
    for (const id of await hitIds(input, term, wanted)) {
      counts.set(key(id), (counts.get(key(id)) ?? 0) + 1);
    }
  }
  const wholeKeys = new Set(whole.map(key));
  const rest = [...counts.keys()]
    .filter((id) => !wholeKeys.has(id))
    .sort(
      (a, b) =>
        (counts.get(b) ?? 0) - (counts.get(a) ?? 0) ||
        (position.get(a) ?? 0) - (position.get(b) ?? 0),
    );
  const byKey = new Map(input.items.map((item) => [compactMeetingId(item.id), item.id]));
  return [
    ...whole.map(key).sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)),
    ...rest,
  ].flatMap((id) => byKey.get(id) ?? []);
}

export interface PickedMeeting {
  readonly item: MeetingListItem;
  /** Position among the relevant hits; absent for a meeting picked only for being recent. */
  readonly rank?: number;
}

/** The meetings one send reads in full: the best hits in rank order, then the newest rest. */
export function pickMeetingsForChat(
  items: readonly MeetingListItem[],
  rankedIds: readonly string[],
  cap: number = MEETING_CAP,
): readonly PickedMeeting[] {
  const byKey = new Map(items.map((item) => [compactMeetingId(item.id), item]));
  const picked: PickedMeeting[] = [];
  const taken = new Set<string>();
  for (const id of rankedIds) {
    if (picked.length >= cap) break;
    const k = compactMeetingId(id);
    const item = byKey.get(k);
    if (item === undefined || taken.has(k)) continue;
    taken.add(k);
    picked.push({ item, rank: picked.length });
  }
  for (const item of [...items].sort(newestFirst)) {
    if (picked.length >= cap) break;
    const k = compactMeetingId(item.id);
    if (taken.has(k)) continue;
    taken.add(k);
    picked.push({ item });
  }
  return picked;
}
