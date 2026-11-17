import { describe, expect, it } from 'vitest';
import type { MeetingListItem } from '../library/meeting';
import {
  foldSearchText,
  type MeetingBody,
  type MeetingSearchText,
} from '../library/meeting-search';
import { MEETING_CAP } from './context-packer';
import { pickMeetingsForChat, rankMeetingsForQuestion } from './meeting-relevance';

const guid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

function item(n: number): MeetingListItem {
  return {
    id: guid(n),
    title: `Meeting ${n}`,
    recordedAt: `2025-01-${String(n).padStart(2, '0')}T08:00:00.0000000+00:00`,
    endedAt: null,
    folderId: null,
    snippet: '',
    hasSummary: false,
    hasTranscript: true,
    busy: false,
  };
}

const text = (transcript: string, title = ''): MeetingSearchText => ({
  title,
  summary: '',
  notes: '',
  transcript,
});

/** Bodies over fixed texts, honoring the filter like the repository does. */
function bodiesOf(texts: Readonly<Record<number, MeetingSearchText>>) {
  return function* (filter: (i: MeetingListItem) => boolean): Generator<MeetingBody> {
    for (const [key, value] of Object.entries(texts)) {
      const meetingItem = item(Number(key));
      if (!filter(meetingItem)) continue;
      yield {
        item: meetingItem,
        folded: foldSearchText(value),
        original: () => Promise.resolve(value),
      };
    }
  };
}

async function* asAsync(source: Iterable<MeetingBody>): AsyncGenerator<MeetingBody> {
  await Promise.resolve();
  yield* source;
}

const rank = (
  items: readonly MeetingListItem[],
  question: string,
  texts: Readonly<Record<number, MeetingSearchText>>,
) =>
  rankMeetingsForQuestion({
    items,
    question,
    bodies: (filter) => asAsync(bodiesOf(texts)(filter)),
  });

describe('rankMeetingsForQuestion', () => {
  const items = [1, 2, 3, 4].map(item);

  it('puts meetings holding the whole question first, accent-insensitive', async () => {
    const ids = await rank(items, 'presupuesto cálculo', {
      1: text('hablamos del presupuesto'),
      2: text('el presupuesto del calculo integral'),
      3: text('nada relevante'),
      4: text('cálculo diferencial'),
    });
    expect(ids[0]).toBe(guid(2));
    expect(ids).toContain(guid(1));
    expect(ids).toContain(guid(4));
    expect(ids).not.toContain(guid(3));
  });

  it('ranks partial matches by how many question words they hold, then newest', async () => {
    const ids = await rank(items, 'alpha beta gamma', {
      1: text('alpha'),
      2: text('alpha beta'),
      3: text('beta'),
      4: text('nothing'),
    });
    expect(ids).toEqual([guid(2), guid(3), guid(1)]);
  });

  it('ignores meetings outside the scoped items', async () => {
    const ids = await rank([item(1)], 'alpha', { 1: text('alpha'), 2: text('alpha') });
    expect(ids).toEqual([guid(1)]);
  });

  it('returns nothing for a question with no searchable word', async () => {
    expect(await rank(items, ' a ', { 1: text('a') })).toEqual([]);
    expect(await rank(items, '', { 1: text('a') })).toEqual([]);
  });
});

describe('pickMeetingsForChat', () => {
  const many = Array.from({ length: 20 }, (_, i) => item(i + 1));

  it('fills the cap with ranked hits first, then the newest remaining', () => {
    const picked = pickMeetingsForChat(many, [guid(2), guid(5)]);
    expect(picked).toHaveLength(MEETING_CAP);
    expect(picked.slice(0, 2).map((p) => p.item.id)).toEqual([guid(2), guid(5)]);
    expect(picked.slice(0, 2).map((p) => p.rank)).toEqual([0, 1]);
    expect(picked.slice(2).map((p) => p.item.id)).toEqual(
      [20, 19, 18, 17, 16, 15, 14, 13, 12, 11].map(guid),
    );
    expect(picked.slice(2).every((p) => p.rank === undefined)).toBe(true);
  });

  it('with no hits it is the newest meetings', () => {
    const picked = pickMeetingsForChat(many, []);
    expect(picked.map((p) => p.item.id)).toEqual(
      Array.from({ length: MEETING_CAP }, (_, i) => guid(20 - i)),
    );
  });

  it('caps the ranked hits too and skips unknown ids', () => {
    const hits = [guid(99), ...many.map((m) => m.id)];
    const picked = pickMeetingsForChat(many, hits);
    expect(picked).toHaveLength(MEETING_CAP);
    expect(picked.every((p) => p.rank !== undefined)).toBe(true);
    expect(picked[0]?.item.id).toBe(guid(1));
  });
});
